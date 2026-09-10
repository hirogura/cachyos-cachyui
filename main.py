#!/usr/bin/env python3
"""
cachy-UI - Web-based Server Management Interface
A lightweight alternative to Webmin, designed to work with Tailscale serve.
"""

import asyncio
import fcntl
import glob
import json
import logging
import os
import pty
import pwd
import re
import select
import shlex
import signal
import ssl
import struct
import subprocess
import sys
import termios
import tempfile
import threading
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

IS_ROOT = os.getuid() == 0

app = FastAPI(title="cachy-UI", version="1.0.0")


@app.middleware("http")
async def no_cache_html(request: Request, call_next):
    """Prevent browsers from serving cached HTML (which pins stale app.js)."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# Static files and templates
BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _sudo(cmd: str) -> str:
    """Prefix command with sudo when not running as root."""
    if IS_ROOT:
        return cmd
    return f"sudo {cmd}"


@app.get("/api/servex/status")
async def servex_status():
    """Check if servEX is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled servex 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/servex", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3359/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}



# --- Helper: run shell command ---
async def run_cmd(cmd: str, timeout: int = 30, extra_env: dict | None = None) -> dict:
    """Run a shell command and return stdout, stderr, returncode."""
    try:
        env = os.environ.copy()
        env["DEBIAN_FRONTEND"] = "noninteractive"
        if extra_env:
            env.update(extra_env)

        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return {
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "returncode": proc.returncode,
        }
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return {"stdout": "", "stderr": "Command timed out", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


def get_primary_user() -> tuple[str, str, str]:
    """
    Find the primary human user on the system, their home directory and login shell.
    Returns (username, home_dir, shell).
    """
    # 1. Try UID 1000 (standard primary user on CachyOS/Arch, UID 1000)
    try:
        pw = pwd.getpwuid(1000)
        if pw and pw.pw_name != "nobody" and pw.pw_shell not in ("/bin/false", "/usr/sbin/nologin"):
            return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"
    except KeyError:
        pass

    # 2. Search for any UID >= 1000 user in /home
    for pw in pwd.getpwall():
        if 1000 <= pw.pw_uid < 65534 and pw.pw_name != "cachyui":
            if pw.pw_shell not in ("/bin/false", "/usr/sbin/nologin", "/bin/sync") and pw.pw_dir.startswith("/home/"):
                return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"

    # 3. Fallback to process owner
    try:
        pw = pwd.getpwuid(os.getuid())
        return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"
    except Exception:
        return "root", "/root", "/bin/bash"



def get_cpu_temperature() -> float | None:
    """Get current CPU temperature in Celsius across different hardware platforms."""
    try:
        temp_data = psutil.sensors_temperatures()
        if temp_data:
            priority_keys = ["coretemp", "cpu_thermal", "k10temp", "zenpower", "soc_thermal", "cpu-thermal"]
            for key in priority_keys:
                if key in temp_data and temp_data[key]:
                    entries = temp_data[key]
                    for entry in entries:
                        if entry.label in ("Package id 0", "Tctl", "Tdie", "CPU", "SoC"):
                            return round(entry.current, 1)
                    return round(entries[0].current, 1)

            for name, entries in temp_data.items():
                if ("cpu" in name.lower() or "core" in name.lower() or "temp" in name.lower()) and entries:
                    return round(entries[0].current, 1)

            for name, entries in temp_data.items():
                if entries:
                    return round(entries[0].current, 1)
    except Exception:
        pass

    try:
        thermal_dir = Path("/sys/class/thermal")
        if thermal_dir.exists():
            for p in thermal_dir.glob("thermal_zone*"):
                type_file = p / "type"
                temp_file = p / "temp"
                if temp_file.exists():
                    ztype = type_file.read_text().strip().lower() if type_file.exists() else ""
                    if "cpu" in ztype or "x86_pkg_temp" in ztype or "pkg" in ztype:
                        val = float(temp_file.read_text().strip()) / 1000.0
                        return round(val, 1)

            tz0 = thermal_dir / "thermal_zone0" / "temp"
            if tz0.exists():
                return round(float(tz0.read_text().strip()) / 1000.0, 1)
    except Exception:
        pass

    return None


# ============================================================
# 1. Dashboard - System Information
# ============================================================
@app.get("/api/system/info")
async def system_info():
    """Get comprehensive system information."""
    cpu_percent = psutil.cpu_percent(interval=1)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count()
    load_avg = os.getloadavg()
    cpu_temp = get_cpu_temperature()

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")

    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime = datetime.now() - boot_time

    # Network I/O
    net = psutil.net_io_counters()

    # Temperature (if available)
    temps = {}
    try:
        temp_data = psutil.sensors_temperatures()
        if temp_data:
            for name, entries in temp_data.items():
                if entries:
                    temps[name] = entries[0].current
    except (AttributeError, Exception):
        pass

    # Get hostname
    hostname_result = await run_cmd("hostname")
    hostname = hostname_result["stdout"].strip()

    # Get OS info
    os_info = await run_cmd("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2")
    os_name = os_info["stdout"].strip() or "Unknown"

    # Get kernel
    kernel_result = await run_cmd("uname -r")
    kernel = kernel_result["stdout"].strip()

    return {
        "hostname": hostname,
        "os": os_name,
        "kernel": kernel,
        "uptime_seconds": int(uptime.total_seconds()),
        "boot_time": boot_time.isoformat(),
        "cpu": {
            "percent": cpu_percent,
            "count_physical": cpu_count,
            "freq_current": round(cpu_freq.current, 0) if cpu_freq else None,
            "temp": cpu_temp,
            "load_avg": {
                "1min": round(load_avg[0], 2),
                "5min": round(load_avg[1], 2),
                "15min": round(load_avg[2], 2),
            },
        },
        "memory": {
            "total": mem.total,
            "available": mem.available,
            "used": mem.used,
            "percent": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_percent": swap.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "network": {
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
            "packets_sent": net.packets_sent,
            "packets_recv": net.packets_recv,
        },
        "temperatures": temps,
    }


@app.get("/api/system/processes")
async def system_processes():
    """Get top processes by CPU usage."""
    procs = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "username"]):
        try:
            info = proc.info
            procs.append({
                "pid": info["pid"],
                "name": info["name"],
                "cpu": info["cpu_percent"] or 0,
                "memory": round(info["memory_percent"] or 0, 1),
                "user": info["username"] or "-",
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    # Sort by CPU desc
    procs.sort(key=lambda x: x["cpu"], reverse=True)
    return procs[:30]


@app.get("/api/ports/listen")
async def ports_listen():
    """List listening services (ss -tulnp) and their LAN accessibility."""
    try:
        return await _collect_listening_ports()
    except Exception as e:
        logging.getLogger("uvicorn.error").exception("ports_listen failed")
        return {"ips": [], "ports": [], "error": str(e)}


async def _collect_listening_ports() -> dict:
    # -H (no header) is not supported by older iproute2; parsing skips headers anyway
    result = await run_cmd("ss -tulnp 2>/dev/null", timeout=15)
    error = None
    local_idx = 4
    if result["returncode"] != 0 or not result["stdout"].strip():
        alt = await run_cmd("netstat -tuln 2>/dev/null", timeout=15)
        if alt["returncode"] == 0 and alt["stdout"].strip():
            result = alt
            local_idx = 3
        else:
            error = f"ss rc={result['returncode']}: {result['stderr'].strip()[:200]}"

    def classify(host: str) -> str:
        if host in ("0.0.0.0", "::", "*", ""):
            return "all"
        ip = host.strip("[]")
        if ip == "::1" or ip.startswith("127."):
            return "local"
        return "limited"

    rows = {}
    for line in result["stdout"].splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto = parts[0]
        addr_field = parts[local_idx]
        if addr_field.startswith("["):
            try:
                close = addr_field.index("]")
                host = addr_field[1:close]
                port = addr_field[close + 1:].rpartition(":")[2]
            except ValueError:
                continue
        else:
            host, _, port = addr_field.rpartition(":")
        host = host.split("%")[0]
        if not port.isdigit():
            continue

        procs = re.findall(r'\(\("([^"]+)",pid=(\d+)', line.rsplit(" ", 1)[-1])
        proc_names = []
        pids = []
        for name, pid in procs:
            if name not in proc_names:
                proc_names.append(name)
            if pid not in pids:
                pids.append(pid)

        key = (proto, host, port)
        if key in rows:
            for name in proc_names:
                if name not in rows[key]["processes"]:
                    rows[key]["processes"].append(name)
            for pid in pids:
                if pid not in rows[key]["pids"]:
                    rows[key]["pids"].append(pid)
        else:
            rows[key] = {
                "proto": "tcp" if proto.startswith("tcp") else "udp",
                "address": host,
                "port": int(port),
                "processes": proc_names,
                "pids": pids,
                "access": classify(host),
            }

    # Host IP addresses per interface (loopback excluded)
    ips = []
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            if iface == "lo":
                continue
            for a in addrs:
                fam = getattr(a.family, "value", a.family)
                if fam in (2, 10) and not str(a.address).startswith("fe80"):
                    addr = str(a.address).split("%")[0]
                    entry = {"iface": iface, "address": addr}
                    if entry not in ips:
                        ips.append(entry)
    except Exception:
        pass

    return {"ips": ips, "ports": sorted(rows.values(), key=lambda r: r["port"]), "error": error}


# ============================================================
# 2. Service Management
# ============================================================
@app.get("/api/services")
async def list_services():
    """List installed services with their status."""
    result = await run_cmd(
        "systemctl list-units --type=service --all --no-pager --plain --no-legend "
        "| awk '{print $1, $3, $4}'",
        timeout=15,
    )
    services = []
    for line in result["stdout"].strip().split("\n"):
        parts = line.split()
        if len(parts) >= 2:
            name = parts[0]
            active = parts[1] if len(parts) > 1 else "unknown"
            sub = parts[2] if len(parts) > 2 else "-"
            services.append({"name": name, "active": active, "sub": sub})
    return services


@app.get("/api/services/{service_name}/status")
async def service_status(service_name: str):
    """Get detailed status of a specific service."""
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(f"systemctl is-active {service_name}")
    is_active = result["stdout"].strip()
    result2 = await run_cmd(f"systemctl status {service_name}")
    return {
        "name": service_name,
        "is_active": is_active,
        "status_output": result2["stdout"],
    }


@app.post("/api/services/{service_name}/start")
async def service_start(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl start {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/stop")
async def service_stop(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl stop {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/restart")
async def service_restart(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl restart {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/enable")
async def service_enable(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl enable {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/disable")
async def service_disable(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl disable {service_name}"))
    return {"success": result["returncode"] == 0, **result}


# ============================================================
# 3. Package Management
# ============================================================
@app.get("/api/packages/updates")
async def check_updates():
    """Check for available package updates (CachyOS / pacman)."""
    # pacman-contrib の checkupdates があればそれを使い、なければ pacman -Qu
    chk = await run_cmd("which checkupdates", timeout=5)
    if chk["returncode"] == 0:
        result = await run_cmd("checkupdates 2>/dev/null", timeout=60)
    else:
        result = await run_cmd("pacman -Qu 2>/dev/null", timeout=60)
    packages = []
    for line in result["stdout"].strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        # 形式: "pkg old -> new" または "pkg new [installed ...]"
        name = line.split()[0]
        packages.append({"name": name, "info": line})
    return {"packages": packages, "count": len(packages)}


@app.post("/api/packages/upgrade")
async def upgrade_packages():
    """Upgrade all packages via pacman -Syu."""
    result = await run_cmd(_sudo("pacman -Syu --noconfirm"), timeout=900)
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }


@app.post("/api/packages/upgrade/{package_name}")
async def upgrade_single_package(package_name: str):
    """Upgrade (or install) a single package via pacman."""
    if not all(c.isalnum() or c in "-_+." for c in package_name):
        raise HTTPException(status_code=400, detail="Invalid package name")
    result = await run_cmd(_sudo(f"pacman -S --noconfirm --needed {package_name}"), timeout=600)
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }


@app.post("/api/packages/fix")
async def fix_packages():
    """Refresh databases and repair keyrings (pacman)."""
    r1 = await run_cmd(_sudo("pacman -Syy --noconfirm"), timeout=300)
    r2 = await run_cmd(_sudo("pacman -S --noconfirm --needed archlinux-keyring cachyos-keyring"), timeout=300)
    success = (r1["returncode"] == 0) and (r2["returncode"] == 0)
    return {
        "success": success,
        "output": (r1["stdout"] + "\n" + r2["stdout"]).strip(),
        "errors": (r1["stderr"] + "\n" + r2["stderr"]).strip(),
    }


@app.post("/api/packages/force-upgrade")
async def force_upgrade_packages():
    """Force full refresh + upgrade (pacman -Syyu)."""
    result = await run_cmd(_sudo("pacman -Syyu --noconfirm"), timeout=900)
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }


@app.post("/api/packages/autoremove")
async def autoremove_packages():
    """Remove orphaned packages (pacman -Qdtq)."""
    check = await run_cmd("pacman -Qdtq 2>/dev/null", timeout=30)
    orphans = [l.strip() for l in check["stdout"].splitlines() if l.strip()]
    if not orphans:
        return {"success": True, "output": "削除すべき孤立パッケージはありません", "errors": ""}
    result = await run_cmd(_sudo("pacman -Rns --noconfirm $(pacman -Qdtq)"), timeout=600)
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }



# ============================================================
# 4. Web Terminal (WebSocket + PTY)
# ============================================================
def _get_user_uid(username: str) -> int:
    """Get UID for a username from /etc/passwd."""
    try:
        pw = pwd.getpwnam(username)
        return pw.pw_uid
    except KeyError:
        return 1000


def _build_term_env(target_user: str, target_home: str, target_shell: str) -> dict:
    """Build environment for terminal process, including keyring/D-Bus vars like selfcode."""
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["SHELL"] = target_shell
    env["USER"] = target_user
    env["LOGNAME"] = target_user
    env["HOME"] = target_home
    env["COLUMNS"] = "120"
    env["LINES"] = "30"

    # Add keyring / D-Bus environment (same as selfcode)
    uid = _get_user_uid(target_user)
    run_user_dir = f"/run/user/{uid}"
    if os.path.isdir(run_user_dir):
        env["XDG_RUNTIME_DIR"] = run_user_dir
        bus_path = os.path.join(run_user_dir, "bus")
        if os.path.exists(bus_path):
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus_path}"
        keyring_dir = os.path.join(run_user_dir, "keyring")
        if os.path.isdir(keyring_dir):
            env["GNOME_KEYRING_CONTROL"] = keyring_dir

    # Add ~/.local/bin to PATH (for CLI tools like agy)
    local_bin = os.path.join(target_home, ".local", "bin")
    if os.path.isdir(local_bin):
        env["PATH"] = f"{local_bin}:{env.get('PATH', '/usr/local/bin:/usr/bin:/bin')}"

    return env


def _sanitize_cwd(cwd: str) -> str:
    """Validate a client-supplied terminal working directory (returns '' when invalid)."""
    cwd = (cwd or "").strip()
    if not cwd or not cwd.startswith("/"):
        return ""
    if ".." in cwd.split("/") or any(ch in cwd for ch in ("\n", "\r", "\x00")):
        return ""
    if not os.path.isdir(cwd):
        return ""
    return cwd


@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket, cwd: str = ""):
    """WebSocket-based terminal using PTY for clean terminal emulation.
    Uses setpriv when running as root (like selfcode), falls back to sudo+su.
    Optional `cwd` query param starts the shell in that directory."""
    await websocket.accept()

    target_user, target_home, target_shell = get_primary_user()
    is_root = os.getuid() == 0
    cur_user_name = pwd.getpwuid(os.getuid()).pw_name
    env = _build_term_env(target_user, target_home, target_shell)
    start_dir = _sanitize_cwd(cwd)

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process: stdin, stdout, and stderr are automatically connected to slave PTY
        try:
            cur_uid = os.getuid()
            cur_user = pwd.getpwuid(cur_uid).pw_name if pwd.getpwuid(cur_uid) else ""

            cd_prefix = f"cd {shlex.quote(start_dir)} && " if start_dir else ""
            inner_cmd = f"{cd_prefix}exec {target_shell} -l"

            if cur_uid == 0 and cur_user != target_user:
                # Running as root: use setpriv for clean user switch (like selfcode)
                # setpriv replaces the process image directly, so job control works correctly
                if start_dir:
                    child_argv = [
                        "/usr/bin/setpriv",
                        f"--reuid={target_user}",
                        f"--regid={target_user}",
                        "--init-groups",
                        "--",
                        "/bin/bash",
                        "-c",
                        inner_cmd,
                    ]
                else:
                    child_argv = [
                        "/usr/bin/setpriv",
                        f"--reuid={target_user}",
                        f"--regid={target_user}",
                        "--init-groups",
                        "--",
                        target_shell,
                        "-l",
                    ]
                os.execvpe("/usr/bin/setpriv", child_argv, env)
            elif cur_user != target_user:
                # Non-root: switch via sudo + su (su is allowed in sudoers)
                if start_dir:
                    child_argv = ["/usr/bin/sudo", "/usr/bin/su", "-", target_user, "-c", inner_cmd]
                else:
                    child_argv = ["/usr/bin/sudo", "/usr/bin/su", "-", target_user]
                os.execvpe("/usr/bin/sudo", child_argv, env)
            else:
                # Already target_user: cd to home directory and launch login shell
                try:
                    os.chdir(start_dir or target_home)
                except Exception:
                    pass
                os.execvpe(target_shell, [target_shell, "-l"], env)
        except Exception:
            try:
                os.chdir(start_dir or target_home)
            except Exception:
                pass
            os.execlp(target_shell, target_shell, "-l")
        sys.exit(1)


    # Parent process
    try:
        winsize = struct.pack("HHHH", 30, 120, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

    loop = asyncio.get_running_loop()

    async def pty_to_ws():
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, master_fd, 4096)
                if not data:
                    break
                await websocket.send_text(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    async def ws_to_pty():
        try:
            while True:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                    msg_type = data.get("type")
                    if msg_type == "input":
                        inp_data = data.get("data", "")
                        os.write(master_fd, inp_data.encode("utf-8"))
                    elif msg_type == "resize":
                        cols = int(data.get("cols", 120))
                        rows = int(data.get("rows", 30))
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except (json.JSONDecodeError, OSError):
                    pass
        except (WebSocketDisconnect, Exception):
            pass

    task_pty = asyncio.create_task(pty_to_ws())
    task_ws = asyncio.create_task(ws_to_pty())

    done, pending = await asyncio.wait(
        [task_pty, task_ws],
        return_when=asyncio.FIRST_COMPLETED,
    )

    for task in pending:
        task.cancel()

    try:
        os.close(master_fd)
    except OSError:
        pass

    try:
        os.kill(pid, signal.SIGHUP)
        await asyncio.sleep(0.05)
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass

    try:
        os.waitpid(pid, os.WNOHANG)
    except (OSError, ChildProcessError):
        pass


# ============================================================
# 5. Wi-Fi Management
# ============================================================
def parse_nmcli_wifi_list(output: str):
    """Parse nmcli terse output for Wi-Fi networks."""
    results = []
    for line in output.strip().split("\n"):
        if not line.strip():
            continue
        parts = re.split(r"(?<!\\):", line)
        parts = [p.replace(r"\:", ":").replace(r"\\", "\\") for p in parts]
        if len(parts) >= 6:
            in_use = parts[0].strip() == "*"
            ssid = parts[1].strip()
            bssid = parts[2].strip()
            signal_str = parts[3].strip()
            signal_val = int(signal_str) if signal_str.isdigit() else 0
            bars = parts[4].strip()
            security = parts[5].strip()
            chan = parts[6].strip() if len(parts) > 6 else ""
            freq = parts[7].strip() if len(parts) > 7 else ""

            if not ssid and not bssid:
                continue

            results.append({
                "in_use": in_use,
                "ssid": ssid or "(非公開ネットワーク)",
                "bssid": bssid,
                "signal": signal_val,
                "bars": bars,
                "security": security or "Open",
                "chan": chan,
                "freq": freq,
            })

    results.sort(key=lambda x: (not x["in_use"], -x["signal"]))
    return results


@app.get("/api/wifi/status")
async def wifi_status():
    """Get Wi-Fi status and current connection info."""
    which_nmcli = await run_cmd("which nmcli")
    nmcli_available = which_nmcli["returncode"] == 0

    if nmcli_available:
        radio = await run_cmd("nmcli radio wifi")
        wifi_enabled = radio["stdout"].strip().lower() == "enabled"

        dev_res = await run_cmd("nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device")
        wifi_devices = []
        active_conn = None

        for line in dev_res["stdout"].strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":")
            if len(parts) >= 3 and parts[1].strip() == "wifi":
                dev_name = parts[0].strip()
                dev_state = parts[2].strip()
                conn_name = parts[3].strip() if len(parts) > 3 else ""
                is_connected = dev_state in ("connected", "接続済み")
                wifi_devices.append({
                    "device": dev_name,
                    "state": dev_state,
                    "connection": conn_name,
                    "connected": is_connected,
                })
                if is_connected and conn_name:
                    active_conn = {
                        "ssid": conn_name,
                        "device": dev_name,
                        "state": dev_state,
                    }

        if active_conn:
            ip_res = await run_cmd(f"ip -4 addr show {active_conn['device']} 2>/dev/null | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){{3}}' || true")
            active_conn["ip"] = ip_res["stdout"].strip()

            wifi_info = await run_cmd("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY device wifi list 2>/dev/null")
            parsed = parse_nmcli_wifi_list(wifi_info["stdout"])
            for net in parsed:
                if net["in_use"] or net["ssid"] == active_conn["ssid"]:
                    active_conn["signal"] = net["signal"]
                    active_conn["security"] = net["security"]
                    active_conn["bssid"] = net["bssid"]
                    break

        return {
            "available": len(wifi_devices) > 0,
            "nmcli": True,
            "enabled": wifi_enabled,
            "connected": active_conn is not None,
            "current": active_conn,
            "devices": wifi_devices,
        }

    # Fallback when nmcli is not present
    wlan_ifaces = []
    try:
        for p in Path("/sys/class/net").iterdir():
            if (p / "wireless").exists() or (p / "phy80211").exists() or p.name.startswith("wl"):
                wlan_ifaces.append(p.name)
    except Exception:
        pass

    return {
        "available": len(wlan_ifaces) > 0,
        "nmcli": False,
        "enabled": len(wlan_ifaces) > 0,
        "connected": False,
        "current": None,
        "devices": [{"device": iface, "state": "unknown", "connected": False} for iface in wlan_ifaces],
        "message": "NetworkManager (nmcli) がインストールされていません。" if not nmcli_available else "",
    }


@app.get("/api/wifi/scan")
async def wifi_scan():
    """Scan for available Wi-Fi networks."""
    which_nmcli = await run_cmd("which nmcli")
    if which_nmcli["returncode"] != 0:
        return {
            "success": False,
            "networks": [],
            "error": "nmcli (NetworkManager) が必要です。sudo pacman -S --needed networkmanager を実行してください。",
        }

    scan_res = await run_cmd(_sudo("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY,CHAN,FREQ device wifi list --rescan yes"), timeout=25)
    if scan_res["returncode"] != 0:
        scan_res = await run_cmd("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY,CHAN,FREQ device wifi list", timeout=15)

    networks = parse_nmcli_wifi_list(scan_res["stdout"])
    return {
        "success": True,
        "networks": networks,
        "count": len(networks),
    }


@app.post("/api/wifi/connect")
async def wifi_connect(req: Request):
    """Connect to a Wi-Fi network."""
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    password = data.get("password", "").strip()
    bssid = data.get("bssid", "").strip()

    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    safe_pwd = password.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    safe_bssid = bssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`') if bssid else ""

    if safe_pwd:
        if safe_bssid:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" password "{safe_pwd}" bssid "{safe_bssid}"')
        else:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" password "{safe_pwd}"')
    else:
        if safe_bssid:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" bssid "{safe_bssid}"')
        else:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}"')

    res = await run_cmd(cmd, timeout=45)
    success = res["returncode"] == 0
    return {
        "success": success,
        "message": res["stdout"].strip() if success else (res["stderr"].strip() or res["stdout"].strip() or "接続に失敗しました"),
    }


@app.post("/api/wifi/disconnect")
async def wifi_disconnect(req: Request):
    """Disconnect currently connected Wi-Fi."""
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    device = data.get("device", "").strip()

    if ssid:
        safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        res = await run_cmd(_sudo(f'nmcli connection down id "{safe_ssid}"'), timeout=15)
        if res["returncode"] == 0:
            return {"success": True, "message": f"{ssid} から切断しました"}

    if device:
        safe_dev = device.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        res = await run_cmd(_sudo(f'nmcli device disconnect "{safe_dev}"'), timeout=15)
        return {
            "success": res["returncode"] == 0,
            "message": res["stdout"].strip() or res["stderr"].strip(),
        }

    wifi_disconnect_cmd = (
        "nmcli -t -f DEVICE,TYPE device | grep ':wifi' | cut -d: -f1 | xargs -r -I{} nmcli device disconnect {}"
        if IS_ROOT
        else "sudo nmcli -t -f DEVICE,TYPE device | grep ':wifi' | cut -d: -f1 | xargs -r -I{} sudo nmcli device disconnect {}"
    )
    res = await run_cmd(wifi_disconnect_cmd, timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": "Wi-Fiを切断しました",
    }


@app.post("/api/wifi/forget")
async def wifi_forget(req: Request):
    """Forget / delete a saved Wi-Fi connection profile."""
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    res = await run_cmd(_sudo(f'nmcli connection delete id "{safe_ssid}"'), timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


@app.post("/api/wifi/toggle")
async def wifi_toggle(req: Request):
    """Turn Wi-Fi radio on/off."""
    data = await req.json()
    enable = data.get("enable", True)
    cmd = _sudo("nmcli radio wifi on") if enable else _sudo("nmcli radio wifi off")
    res = await run_cmd(cmd, timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


# ============================================================
# 6. Disk Management
# ============================================================

async def get_sfdisk_free_info(disk_name):
    """Parse sfdisk to detect free regions and per-partition extendability."""
    disk_path = f"/dev/{disk_name}"
    result = {"total_free_bytes": 0, "partitions": []}

    res = await run_cmd(f"sfdisk -d {disk_path} 2>/dev/null", timeout=10)
    if res["returncode"] != 0:
        return result

    lines = res["stdout"].strip().split("\n")
    partitions = []
    last_lba = 0
    sector_size = 512

    for line in lines:
        line = line.strip()
        if line.startswith("last-lba:"):
            last_lba = int(line.split(":")[1].strip())
        elif line.startswith("sector-size:"):
            sector_size = int(line.split(":")[1].strip())
        elif line.startswith("/dev/"):
            start = size = None
            name = line.split(":")[0].split("/")[-1].strip()
            for field in line.split(":")[1].split(","):
                field = field.strip()
                if field.startswith("start="):
                    start = int(field.split("=")[1])
                elif field.startswith("size="):
                    size = int(field.split("=")[1])
            if start is not None and size is not None:
                partitions.append({"name": name, "start": start, "size": size, "end": start + size})

    if not partitions:
        return result

    partitions.sort(key=lambda p: p["start"])

    # GPT reserves first 34 sectors and last 33 sectors
    gpt_reserved_end = 34
    gpt_reserved_start = last_lba - 32 if last_lba > 32 else last_lba

    # Find free regions and mark extendable partitions
    free_sectors = 0
    current_pos = gpt_reserved_end

    for p in partitions:
        # Free space before this partition
        if p["start"] > current_pos:
            free_sectors += p["start"] - current_pos

        # Mark previous partition as extendable if there was a gap
        if partitions.index(p) > 0:
            prev = partitions[partitions.index(p) - 1]
            if p["start"] > prev["end"]:
                prev["extendable"] = True
                prev["max_extend_bytes"] = (p["start"] - prev["end"]) * sector_size

        current_pos = p["end"]

    # Free space after last partition
    usable_end = gpt_reserved_start
    if usable_end > current_pos:
        free_sectors += usable_end - current_pos
        partitions[-1]["extendable"] = True
        partitions[-1]["max_extend_bytes"] = (usable_end - partitions[-1]["end"]) * sector_size

    # Initialize non-extendable partitions
    for p in partitions:
        if "extendable" not in p:
            p["extendable"] = False
            p["max_extend_bytes"] = 0

    result["total_free_bytes"] = free_sectors * sector_size
    result["partitions"] = partitions
    return result


async def _get_lvm_info():
    """Gather LVM VG/LV info, keyed by PV device name."""
    result = {}
    pvs_res = await run_cmd("pvs --reportformat json -o pv_name,vg_name,pv_size,pv_free 2>/dev/null", timeout=10)
    if pvs_res["returncode"] != 0:
        return result
    try:
        pvs_data = json.loads(pvs_res["stdout"])
        for report in pvs_data.get("report", []):
            for pv in report.get("pv", []):
                pv_name = pv["pv_name"].split("/")[-1]
                result[pv_name] = {
                    "vg_name": pv["vg_name"],
                    "pv_size": pv["pv_size"],
                    "pv_free": pv["pv_free"],
                    "lvs": [],
                }
    except (json.JSONDecodeError, KeyError):
        return result

    vgs_res = await run_cmd("vgs --reportformat json -o vg_name,vg_size,vg_free 2>/dev/null", timeout=10)
    if vgs_res["returncode"] == 0:
        try:
            vgs_data = json.loads(vgs_res["stdout"])
            for report in vgs_data.get("report", []):
                for vg in report.get("vg", []):
                    for pv_info in result.values():
                        if pv_info["vg_name"] == vg["vg_name"]:
                            pv_info["vg_size"] = vg["vg_size"]
                            pv_info["vg_free"] = vg["vg_free"]
        except (json.JSONDecodeError, KeyError):
            pass

    lvs_res = await run_cmd("lvs --reportformat json -o lv_name,vg_name,lv_size,lv_path 2>/dev/null", timeout=10)
    if lvs_res["returncode"] == 0:
        try:
            lvs_data = json.loads(lvs_res["stdout"])
            for report in lvs_data.get("report", []):
                for lv in report.get("lv", []):
                    lv_path = lv.get("lv_path", "")
                    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
                    mountpoint = mp_res["stdout"].strip()
                    for pv_info in result.values():
                        if pv_info["vg_name"] == lv["vg_name"]:
                            pv_info["lvs"].append({
                                "name": lv["lv_name"],
                                "size": lv["lv_size"],
                                "path": lv_path,
                                "mountpoint": mountpoint,
                            })
        except (json.JSONDecodeError, KeyError):
            pass

    return result


@app.get("/api/disks/info")
async def disks_info():
    """Get disk and partition information using lsblk + df."""
    # lsblk: NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RM,RO,MODEL,SERIAL
    lsblk_res = await run_cmd(
        "lsblk -J -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RM,RO,MODEL,SERIAL,UUID,PARTLABEL,LABEL 2>/dev/null",
        timeout=10,
    )

    # df -h for all mounted filesystems (skip tmpfs, devtmpfs etc.)
    df_res = await run_cmd(
        "df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2",
        timeout=10,
    )

    # Parse lsblk JSON
    blocks = []
    try:
        blk_data = json.loads(lsblk_res["stdout"])
        blocks = blk_data.get("blockdevices", [])
    except (json.JSONDecodeError, KeyError):
        pass

    # Parse df output into a dict keyed by mountpoint
    df_info = {}
    for line in df_res["stdout"].strip().split("\n"):
        parts = line.split()
        if len(parts) >= 6:
            mount = parts[5]
            df_info[mount] = {
                "filesystem": parts[0],
                "size": parts[1],
                "used": parts[2],
                "avail": parts[3],
                "use_percent": parts[4],
                "mountpoint": mount,
            }

    def parse_size_bytes(size_str):
        """Convert human-readable size (e.g. '50G') to bytes."""
        if not size_str:
            return 0
        multipliers = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}
        size_str = str(size_str).strip()
        if size_str[-1].upper() in multipliers:
            return int(float(size_str[:-1]) * multipliers[size_str[-1].upper()])
        try:
            return int(float(size_str))
        except ValueError:
            return 0

    def parse_device(dev):
        """Recursively parse a lsblk device entry."""
        fstype = dev.get("fstype") or ""
        mountpoint = dev.get("mountpoint") or ""
        name = dev.get("name", "")
        size = dev.get("size", "")
        rm = dev.get("rm", False)
        ro = dev.get("ro", False)
        model = (dev.get("model") or "").strip()
        serial = (dev.get("serial") or "").strip()
        uuid = dev.get("uuid") or ""
        partlabel = (dev.get("partlabel") or "").strip()
        fslabel = (dev.get("label") or "").strip()
        devtype = dev.get("type", "")

        entry = {
            "name": name,
            "size": size,
            "size_bytes": parse_size_bytes(size),
            "type": devtype,
            "fstype": fstype,
            "mountpoint": mountpoint,
            "removable": rm,
            "readonly": ro,
            "model": model,
            "serial": serial,
            "uuid": uuid,
            "partlabel": partlabel,
            "label": fslabel,
        }

        # Merge df data if mounted
        if mountpoint and mountpoint in df_info:
            entry["df"] = df_info[mountpoint]

        # Recurse into children (partitions of a disk)
        children = dev.get("children", [])
        if children:
            entry["children"] = [parse_device(c) for c in children]

        return entry

    devices = [parse_device(d) for d in blocks]

    # Enrich disk entries with free space info from sfdisk
    for dev in devices:
        if dev.get("type") == "disk":
            if not dev.get("children") and not dev.get("fstype"):
                # Blank disk (no partition table / filesystem): sfdisk reports
                # nothing, so treat the whole usable area as free space.
                # Reserve the 2048-sector alignment offset plus trailing GPT sectors.
                gpt_overhead = (2048 + 33) * 512
                dev["free_bytes"] = max(dev.get("size_bytes", 0) - gpt_overhead, 0)
            else:
                free_info = await get_sfdisk_free_info(dev["name"])
                dev["free_bytes"] = free_info["total_free_bytes"]
                part_map = {p["name"]: p for p in free_info["partitions"]}
                for child in dev.get("children", []):
                    if child["name"] in part_map:
                        child["extendable"] = part_map[child["name"]]["extendable"]
                        child["max_extend_bytes"] = part_map[child["name"]]["max_extend_bytes"]

    # Enrich LVM2_member partitions with VG/LV info
    lvm_data = await _get_lvm_info()
    def enrich_lvm(entries):
        for e in entries:
            if e.get("fstype") == "LVM2_member" and e.get("name") in lvm_data:
                e["lvm"] = lvm_data[e["name"]]
            for child in e.get("children", []):
                enrich_lvm([child])
    enrich_lvm(devices)

    return {"devices": devices}


@app.post("/api/disks/mount")
async def disks_mount(req: Request):
    """Mount a partition. Supports temporary or persistent (fstab) mount."""
    data = await req.json()
    device_name = data.get("device", "").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)
    fstype = data.get("fstype", "").strip()

    if not device_name or not mount_point:
        raise HTTPException(status_code=400, detail="device and mount_point are required")

    # Build full device path
    device_path = f"/dev/{device_name}" if not device_name.startswith("/dev/") else device_name

    # Validate device exists
    check = await run_cmd(f"test -b {device_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"デバイス {device_path} が見つかりません"}

    # Create mount point if it doesn't exist
    await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)

    if persistent:
        # Get UUID for fstab
        blkid = await run_cmd(f"blkid -s UUID -o value {device_path}", timeout=5)
        uuid = blkid["stdout"].strip()
        if not uuid:
            return {"success": False, "message": "UUIDを取得できませんでした"}

        # Determine fstype for fstab if not provided
        if not fstype:
            blkid_type = await run_cmd(f"blkid -s TYPE -o value {device_path}", timeout=5)
            fstype = blkid_type["stdout"].strip()

        if not fstype:
            return {"success": False, "message": "ファイルシステムタイプを取得できませんでした"}

        # Check if already in fstab
        fstab_check = await run_cmd(f"grep -q '{uuid}' /etc/fstab", timeout=5)
        if fstab_check["returncode"] == 0:
            return {"success": False, "message": "このデバイスは既に/etc/fstabに登録されています"}

        # Add to fstab (options: defaults,nofail for safety)
        fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
        add_fstab = await run_cmd(
            _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
            timeout=10,
        )
        if add_fstab["returncode"] != 0:
            return {"success": False, "message": f"/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}"}

        # Now mount it
        mount_res = await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": False, "message": f"マウントに失敗しました: {mount_res['stderr']}"}

        return {"success": True, "message": f"永続マウントしました: {device_path} → {mount_point}"}

    else:
        # Temporary mount
        mount_res = await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": False, "message": f"マウントに失敗しました: {mount_res['stderr']}"}
        return {"success": True, "message": f"一時マウントしました: {device_path} → {mount_point}"}


@app.post("/api/disks/unmount")
async def disks_unmount(req: Request):
    """Unmount a partition. With force=True, use lazy unmount (umount -l)
    so busy mount points (e.g. open terminal cwd) can still be detached."""
    data = await req.json()
    device_name = data.get("device", "").strip()
    mount_point = data.get("mount_point", "").strip()
    force = bool(data.get("force", False))

    if not device_name and not mount_point:
        raise HTTPException(status_code=400, detail="device or mount_point is required")

    target = mount_point if mount_point else f"/dev/{device_name}"
    device_path = f"/dev/{device_name}" if not device_name.startswith("/dev/") else device_name

    # Unmount
    umount_opts = "-l" if force else ""
    res = await run_cmd(_sudo(f"umount {umount_opts} {target}".strip()), timeout=30)
    if res["returncode"] != 0:
        return {"success": False, "message": f"アンマウントに失敗しました: {res['stderr']}"}

    # If there was a fstab entry, offer info (don't auto-remove for safety)
    fstab_check = await run_cmd(f"grep -n '{device_path}\\|{mount_point}' /etc/fstab 2>/dev/null", timeout=5)
    fstab_entry = fstab_check["stdout"].strip() if fstab_check["returncode"] == 0 else ""

    msg = f"強制アンマウントしました: {target}" if force else f"アンマウントしました: {target}"
    if force:
        msg += "\n（使用中のプロセスからは切り離されています。ターミナルで開いていた場合は閉じてください）"
    if fstab_entry:
        msg += "\n注意: /etc/fstabにエントリが残っています。永続マウント設定を解除する場合はターミナルで手動で削除してください。"

    return {"success": True, "message": msg, "fstab_entry": fstab_entry}


@app.post("/api/disks/partition/create")
async def disks_partition_create(req: Request):
    """Create a new partition on a disk with optional filesystem and mount."""
    data = await req.json()
    disk_name = data.get("disk", "").strip()
    size_sectors = data.get("size_sectors", 0)
    fstype = data.get("fstype", "ext4").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)
    raw_label = data.get("label", "") or ""
    # Filesystem-safe label: alphanumerics, dot, underscore, hyphen only
    label = "".join(c for c in raw_label.strip() if c.isalnum() or c in "._-")[:16]

    if not disk_name or size_sectors <= 0:
        raise HTTPException(status_code=400, detail="disk and size_sectors are required")

    disk_path = f"/dev/{disk_name}"

    # Verify it's a disk device
    type_check = await run_cmd(f"lsblk -dno TYPE {disk_path} 2>/dev/null", timeout=5)
    if type_check["stdout"].strip() != "disk":
        return {"success": False, "message": f"{disk_path} はディスクデバイスではありません"}

    # Create partition using sfdisk
    type_uuid = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"  # Linux filesystem
    if fstype == "swap":
        type_uuid = "0657FD6D-A4AB-43C4-84B5-1560EF63A218"  # Linux swap
    elif fstype in ("vfat", "fat32", "fat16"):
        type_uuid = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"  # EFI System

    name_field = f', name="{label}"' if label else ""
    sfdisk_input = f"type={type_uuid}, size={size_sectors}{name_field}"

    # Detect existing partition table; a blank disk needs an explicit GPT label
    # (sfdisk would otherwise default to DOS, which rejects GPT type UUIDs)
    table_check = await run_cmd(f"sfdisk -d {disk_path} 2>/dev/null", timeout=10)
    has_table = table_check["returncode"] == 0 and any(
        line.strip().startswith("/dev/") for line in table_check["stdout"].splitlines()
    )

    if has_table:
        res = await run_cmd(
            _sudo(f"echo '{sfdisk_input}' | sfdisk --append --no-reread {disk_path}"),
            timeout=15,
        )
    else:
        # Cap the size so the partition fits before the last usable GPT sector
        size_res = await run_cmd(f"lsblk -bno SIZE {disk_path} 2>/dev/null", timeout=5)
        try:
            total_sectors = int(size_res["stdout"].strip()) // 512
        except ValueError:
            total_sectors = 0
        max_sectors = max(total_sectors - 2048 - 33, 0)
        if max_sectors <= 0:
            return {"success": False, "message": f"{disk_path} はパーティションを作成できる大きさがありません"}
        if size_sectors > max_sectors:
            size_sectors = max_sectors
        sfdisk_script = f"label: gpt\\ntype={type_uuid}, size={size_sectors}{name_field}\\n"
        res = await run_cmd(
            _sudo(f"printf '{sfdisk_script}' | sfdisk --no-reread {disk_path}"),
            timeout=15,
        )
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション作成に失敗しました: {res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)
    await asyncio.sleep(1)

    # Find the newly created partition
    lsblk_res = await run_cmd(f"lsblk -Jno NAME,SIZE,TYPE {disk_path} 2>/dev/null", timeout=10)
    new_part_name = None
    try:
        blk = json.loads(lsblk_res["stdout"])
        children = blk.get("blockdevices", [])
        if children:
            parts = children[0].get("children", [])
            if parts:
                new_part_name = parts[-1]["name"]
    except (json.JSONDecodeError, KeyError):
        pass

    if not new_part_name:
        return {"success": True, "message": "パーティションを作成しました（デバイス名の取得に失敗しました）"}

    new_part_path = f"/dev/{new_part_name}"

    # Format filesystem (skip for swap)
    label_flag = "-n" if fstype in ("vfat", "fat32", "fat16") else "-L"
    label_opt = f" {label_flag} '{label}'" if label else ""
    if fstype == "swap":
        mkfs_res = await run_cmd(_sudo(f"mkswap{label_opt} {new_part_path}"), timeout=30)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"swapの作成に失敗しました: {mkfs_res['stderr']}"}
        msg = f"パーティション {new_part_name} を作成し、swapとして初期化しました"
        if label:
            msg += f" (ラベル: {label})"
        return {"success": True, "message": msg, "device": new_part_name}
    else:
        mkfs_cmd = f"mkfs.{fstype}{label_opt} {new_part_path}"
        mkfs_res = await run_cmd(_sudo(mkfs_cmd), timeout=60)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム作成に失敗しました: {mkfs_res['stderr']}"}

    # Mount if requested
    if mount_point:
        await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)
        mount_res = await run_cmd(_sudo(f"mount {new_part_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": True, "message": f"パーティション {new_part_name} を作成しましたが、マウントに失敗しました: {mount_res['stderr']}", "device": new_part_name}

        if persistent:
            blkid = await run_cmd(f"blkid -s UUID -o value {new_part_path}", timeout=5)
            uuid = blkid["stdout"].strip()
            if uuid:
                fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
                add_fstab = await run_cmd(
                    _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
                    timeout=10,
                )
                if add_fstab["returncode"] != 0:
                    return {"success": True, "message": f"パーティション {new_part_name} を作成しましたが、/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}", "device": new_part_name}

    msg = f"パーティション {new_part_name} を作成しました ({fstype})"
    if label:
        msg += f" ラベル: {label}"
    if mount_point:
        msg += f" → {mount_point}"
    if persistent and mount_point:
        msg += " (永続マウント)"
    return {"success": True, "message": msg, "device": new_part_name}


@app.post("/api/disks/partition/extend")
async def disks_partition_extend(req: Request):
    """Extend a partition to use available free space."""
    data = await req.json()
    device_name = data.get("device", "").strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="device is required")

    device_path = f"/dev/{device_name}"

    # Verify it's a partition
    type_check = await run_cmd(f"lsblk -dno TYPE {device_path} 2>/dev/null", timeout=5)
    dev_type = type_check["stdout"].strip()
    if dev_type not in ("part", "lvm"):
        return {"success": False, "message": f"{device_path} はパーティションではありません"}

    # Find parent disk and get free info
    parent_res = await run_cmd(f"lsblk -dno PKNAME {device_path} 2>/dev/null", timeout=5)
    parent_disk = parent_res["stdout"].strip()
    if not parent_disk:
        return {"success": False, "message": "親ディスクが見つかりません"}

    free_info = await get_sfdisk_free_info(parent_disk)
    part_info = None
    for p in free_info["partitions"]:
        if p["name"] == device_name:
            part_info = p
            break

    if not part_info or not part_info.get("extendable"):
        return {"success": False, "message": "このパーティションは拡張できません（隣接する空き領域がありません）"}

    max_bytes = part_info["max_extend_bytes"]
    sector_size = 512
    add_sectors = max_bytes // sector_size
    new_size_sectors = part_info["size"] + add_sectors

    # Get partition number from name (e.g., vda3 -> 3)
    part_num = ""
    for ch in reversed(device_name):
        if ch.isdigit():
            part_num = ch + part_num
        else:
            break

    if not part_num:
        return {"success": False, "message": "パーティション番号を取得できませんでした"}

    disk_path = f"/dev/{parent_disk}"

    # Check if the partition is mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {device_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()

    # Detect filesystem type
    fs_res = await run_cmd(f"blkid -s TYPE -o value {device_path} 2>/dev/null", timeout=5)
    fs_type = fs_res["stdout"].strip()

    # Unmount if mounted (resize2fs/xfs_growfs can work online but partition resize needs unmount for safety)
    needs_remount = False
    if mountpoint:
        unmount_res = await run_cmd(_sudo(f"umount {device_path}"), timeout=15)
        if unmount_res["returncode"] != 0:
            return {"success": False, "message": f"アンマウントに失敗しました: {unmount_res['stderr']}"}
        needs_remount = True

    # Resize partition using sfdisk
    sfdisk_input = f"{part_num}: size={new_size_sectors}"
    resize_res = await run_cmd(
        _sudo(f"echo '{sfdisk_input}' | sfdisk --no-reread -N {part_num} {disk_path}"),
        timeout=15,
    )
    if resize_res["returncode"] != 0:
        # Try to remount if we unmounted
        if needs_remount and mountpoint:
            await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        return {"success": False, "message": f"パーティション拡張に失敗しました: {resize_res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)
    await asyncio.sleep(1)

    # Resize filesystem
    if fs_type == "ext4" or fs_type == "ext3" or fs_type == "ext2":
        fs_res = await run_cmd(_sudo(f"resize2fs {device_path}"), timeout=30)
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res['stderr']}"}
    elif fs_type == "xfs":
        # XFS needs a mount point for growfs
        if mountpoint:
            fs_res = await run_cmd(_sudo(f"xfs_growfs {mountpoint}"), timeout=30)
        else:
            fs_res = {"returncode": 1, "stderr": "XFSはマウントされていない状態では拡張できません"}
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res.get('stderr', 'unknown error')}"}
    elif fs_type == "btrfs":
        if mountpoint:
            fs_res = await run_cmd(_sudo(f"btrfs filesystem resize max {mountpoint}"), timeout=30)
        else:
            fs_res = {"returncode": 1, "stderr": "Btrfsはマウントされていない状態では拡張できません"}
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res.get('stderr', 'unknown error')}"}

    # Remount if needed
    if needs_remount and mountpoint:
        await run_cmd(_sudo(f"mount {device_path} {mountpoint}"), timeout=15)

    msg = f"パーティション {device_name} を拡張しました (+{_format_bytes(max_bytes)})"
    if needs_remount and mountpoint:
        msg += f" (マウント済み: {mountpoint})"
    return {"success": True, "message": msg}


def _format_bytes(b):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if b < 1024:
            return f"{b:.1f}{unit}"
        b /= 1024
    return f"{b:.1f}PB"


@app.post("/api/disks/lv/create")
async def disks_lv_create(req: Request):
    """Create a new logical volume in a VG, format and optionally mount."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()
    size = data.get("size", "").strip()
    fstype = data.get("fstype", "ext4").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)

    if not vg_name or not lv_name or not size:
        raise HTTPException(status_code=400, detail="vg_name, lv_name, and size are required")

    # Create LV
    lv_path = f"/dev/{vg_name}/{lv_name}"
    res = await run_cmd(_sudo(f"lvcreate -L {size} -n {lv_name} --yes {vg_name}"), timeout=30)
    if res["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム作成に失敗しました: {res['stderr']}"}

    # Format
    if fstype == "swap":
        mkfs_res = await run_cmd(_sudo(f"mkswap {lv_path}"), timeout=30)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"swapの初期化に失敗しました: {mkfs_res['stderr']}"}
        swapon_res = await run_cmd(_sudo(f"swapon {lv_path}"), timeout=10)
        msg = f"LV {lv_name} を作成し、swapとして有効にしました"
        return {"success": True, "message": msg, "device": lv_name}
    else:
        mkfs_res = await run_cmd(_sudo(f"mkfs.{fstype} {lv_path}"), timeout=60)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム作成に失敗しました: {mkfs_res['stderr']}"}

    # Mount if requested
    if mount_point:
        await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)
        mount_res = await run_cmd(_sudo(f"mount {lv_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": True, "message": f"LV {lv_name} を作成しましたが、マウントに失敗しました: {mount_res['stderr']}", "device": lv_name}

        if persistent:
            blkid = await run_cmd(f"blkid -s UUID -o value {lv_path}", timeout=5)
            uuid = blkid["stdout"].strip()
            if uuid:
                fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
                add_fstab = await run_cmd(
                    _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
                    timeout=10,
                )
                if add_fstab["returncode"] != 0:
                    return {"success": True, "message": f"LV {lv_name} を作成しましたが、/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}", "device": lv_name}

    msg = f"LV {lv_name} を作成しました ({fstype}, {size})"
    if mount_point:
        msg += f" → {mount_point}"
    if persistent and mount_point:
        msg += " (永続マウント)"
    return {"success": True, "message": msg, "device": lv_name}


@app.post("/api/disks/lv/resize")
async def disks_lv_resize(req: Request):
    """Resize a logical volume and its filesystem."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()
    size = data.get("size", "").strip()  # e.g., "30G" or "+10G"

    if not vg_name or not lv_name or not size:
        raise HTTPException(status_code=400, detail="vg_name, lv_name, and size are required")

    lv_path = f"/dev/{vg_name}/{lv_name}"

    # Check if LV exists
    check = await run_cmd(f"test -b {lv_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム {lv_path} が見つかりません"}

    # Detect filesystem type
    fs_res = await run_cmd(f"blkid -s TYPE -o value {lv_path} 2>/dev/null", timeout=5)
    fs_type = fs_res["stdout"].strip()

    # Get mount point
    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()

    # Resize LV
    resize_cmd = f"lvresize -r -L {size} {lv_path}"
    res = await run_cmd(_sudo(resize_cmd), timeout=30)
    if res["returncode"] != 0:
        return {"success": False, "message": f"LVリサイズに失敗しました: {res['stderr']}"}

    msg = f"LV {lv_name} を {size} にリサイズしました"
    if mountpoint:
        msg += f" (マウント済み: {mountpoint})"
    return {"success": True, "message": msg}


@app.post("/api/disks/partition/delete")
async def disks_partition_delete(req: Request):
    """Delete a partition from a disk."""
    data = await req.json()
    device_name = data.get("device", "").strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="device is required")

    device_path = f"/dev/{device_name}"

    # Verify it's a partition
    type_check = await run_cmd(f"lsblk -dno TYPE {device_path} 2>/dev/null", timeout=5)
    dev_type = type_check["stdout"].strip()
    if dev_type not in ("part", "lvm"):
        return {"success": False, "message": f"{device_path} はパーティションではありません"}

    # Check if mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {device_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()
    if mountpoint:
        return {"success": False, "message": f"マウント中のパーティションは削除できません（{mountpoint}）。\n先にアンマウントしてください。"}

    # Get parent disk
    parent_res = await run_cmd(f"lsblk -dno PKNAME {device_path} 2>/dev/null", timeout=5)
    parent_disk = parent_res["stdout"].strip()
    if not parent_disk:
        return {"success": False, "message": "親ディスクが見つかりません"}

    # Check if it's an LVM PV - refuse deletion if so
    pv_check = await run_cmd(f"pvs --noheadings -o vg_name {device_path} 2>/dev/null", timeout=5)
    if pv_check["returncode"] == 0 and pv_check["stdout"].strip():
        return {"success": False, "message": f"このパーティションはLVM物理ボリュームとして使用中です（VG: {pv_check['stdout'].strip()}）。LVを先に削除してください。"}

    # Get partition number
    part_num = ""
    for ch in reversed(device_name):
        if ch.isdigit():
            part_num = ch + part_num
        else:
            break
    if not part_num:
        return {"success": False, "message": "パーティション番号を取得できませんでした"}

    disk_path = f"/dev/{parent_disk}"

    # Delete partition using sfdisk
    res = await run_cmd(_sudo(f"sfdisk --delete {disk_path} {part_num}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション削除に失敗しました: {res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)

    return {"success": True, "message": f"パーティション {device_name} を削除しました"}


@app.post("/api/disks/disk/wipe")
async def disks_disk_wipe(req: Request):
    """Delete all partitions from a disk."""
    data = await req.json()
    disk_name = data.get("device", "").strip()

    if not disk_name:
        raise HTTPException(status_code=400, detail="device is required")

    disk_path = f"/dev/{disk_name}"

    # Verify it's a disk
    type_check = await run_cmd(f"lsblk -dno TYPE {disk_path} 2>/dev/null", timeout=5)
    if type_check["stdout"].strip() != "disk":
        return {"success": False, "message": f"{disk_path} はディスクデバイスではありません"}

    # Check if any partition is mounted
    mp_check = await run_cmd(f"findmnt -n -o TARGET,SOURCE 2>/dev/null | grep '{disk_path}'", timeout=5)
    if mp_check["stdout"].strip():
        return {"success": False, "message": "マウント中のパーティションが含まれています。先にすべてアンマウントしてください。"}

    # Check if any partition is an LVM PV
    pv_check = await run_cmd(f"pvs --noheadings -o pv_name,vg_name 2>/dev/null | grep '{disk_path}'", timeout=5)
    if pv_check["stdout"].strip():
        return {"success": False, "message": f"LVM物理ボリュームが含まれています。先にVGを削除してください。\n{pv_check['stdout'].strip()}"}

    # Delete all partitions
    res = await run_cmd(_sudo(f"sfdisk --delete {disk_path}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション削除に失敗しました: {res['stderr']}"}

    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)

    return {"success": True, "message": f"ディスク {disk_name} の全パーティションを削除しました"}


@app.post("/api/disks/lv/delete")
async def disks_lv_delete(req: Request):
    """Delete a logical volume."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()

    if not vg_name or not lv_name:
        raise HTTPException(status_code=400, detail="vg_name and lv_name are required")

    lv_path = f"/dev/{vg_name}/{lv_name}"

    # Check if LV exists
    check = await run_cmd(f"test -b {lv_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム {lv_path} が見つかりません"}

    # Check if mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()
    if mountpoint:
        return {"success": False, "message": f"マウント中の論理ボリュームは削除できません（{mountpoint}）。\n先にアンマウントしてください。"}

    # Check if it's swap
    swap_res = await run_cmd(f"swapon --show=NAME --noheadings 2>/dev/null | grep -q '{lv_path}'", timeout=5)
    if swap_res["returncode"] == 0:
        await run_cmd(_sudo(f"swapoff {lv_path}"), timeout=15)

    # Delete LV
    res = await run_cmd(_sudo(f"lvremove -f {lv_path}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム削除に失敗しました: {res['stderr']}"}

    return {"success": True, "message": f"論理ボリューム {lv_name} を削除しました"}


# ============================================================
# 7. cachy-UI Management & System Control
# ============================================================
@app.get("/api/selfcode/status")
async def selfcode_status():
    """Check if selfcode is installed and return its URL."""
    # Check if systemd service exists or directory exists
    svc = await run_cmd("systemctl is-enabled selfcode 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/lxd-data/selfcode", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        # Get Tailscale hostname
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3339/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}



@app.get("/api/easylxd/status")

async def easylxd_status():
    """Check if Easy LXD is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled easy-lxd 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/easy-lxd", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3329/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


@app.get("/api/vmmanager/status")
async def vmmanager_status():
    """Check if VM Manager is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled vm-manage 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/vm-manage", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:8090/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


@app.get("/api/ddrescuegui/status")
async def ddrescuegui_status():
    """Check if ddrescueGUI is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled ddrescuegui 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/ddrescuegui", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3327/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


# ============================================================
# ============================================================
# 7.5 バックアップ / 復元 (Clonezilla Live / Limine 方式)
# ============================================================
# cachyos-clonezilla-auto と同じ方式:
# ISO から vmlinuz/initramfs を /boot/isos/ に取り出し、
# /boot/limine.conf の「/+ISO Boot」に Clonezilla-AutoBackup /
# Clonezilla-AutoRestore サブエントリを追加して無人実行する。
CLONE_ISO_DIR = "/iso"
CLONE_ISO_GLOB = "clonezilla-live-*.iso"
IMAGE_PREFIX_FALLBACK = "cachyos"
AUTO_BACKUP_STUB = "Clonezilla-AutoBackup"
AUTO_RESTORE_STUB = "Clonezilla-AutoRestore"


def _validate_block_device(device: str) -> str:
    if not re.fullmatch(r"/dev/[A-Za-z0-9._-]+", device or ""):
        raise HTTPException(status_code=400, detail="invalid device")
    return device


def _parse_lsblk_partitions(stdout: str) -> list[dict]:
    parts = []
    for line in stdout.splitlines():
        if 'TYPE="part"' not in line or 'FSTYPE="swap"' in line:
            continue
        fields = dict(re.findall(r'([A-Z]+)="((?:[^"\\]|\\.)*)"', line))
        parts.append({
            "device": f"/dev/{fields.get('NAME', '')}",
            "size": fields.get("SIZE", ""),
            "fstype": fields.get("FSTYPE") or None,
            "mountpoint": fields.get("MOUNTPOINT") or None,
        })
    return parts


async def _list_clonezilla_partitions() -> list[dict]:
    r = await run_cmd("lsblk -P -o NAME,SIZE,FSTYPE,MOUNTPOINT,TYPE", timeout=15)
    if r["returncode"] != 0:
        raise HTTPException(status_code=500, detail=r["stderr"] or "lsblk failed")
    return _parse_lsblk_partitions(r["stdout"])


def _clonezilla_image_prefix() -> str:
    return IMAGE_PREFIX_FALLBACK


async def _find_clonezilla_iso() -> str | None:
    matches = sorted(Path(CLONE_ISO_DIR).glob(CLONE_ISO_GLOB))
    return str(matches[-1]) if matches else None


async def _system_target_parts() -> list[str]:
    """バックアップ対象: /boot/efi (vfat)・/boot (分離時)・/ の順。"""
    parts: list[str] = []
    r = await run_cmd("findmnt -n -o SOURCE,FSTYPE /boot/efi", timeout=5)
    if r["returncode"] == 0:
        fields = r["stdout"].split()
        if len(fields) == 2 and fields[1] == "vfat":
            parts.append(fields[0].split("[")[0])
    b = await run_cmd("findmnt -n -o SOURCE /boot", timeout=5)
    if b["returncode"] == 0 and b["stdout"].strip():
        boot = b["stdout"].strip().split("[")[0]
        rr = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
        if boot != rr["stdout"].strip().split("[")[0]:
            parts.append(boot)
    r = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
    if r["returncode"] == 0 and r["stdout"].strip():
        parts.append(r["stdout"].strip().split("[")[0])
    # 重複除去
    uniq: list[str] = []
    for p in parts:
        if p not in uniq:
            uniq.append(p)
    return uniq


async def _list_clonezilla_images(device: str) -> list[str]:
    check = await run_cmd(f"test -b {device}", timeout=5)
    if check["returncode"] != 0:
        raise HTTPException(status_code=400, detail=f"{device} is not a block device")
    prefix = _clonezilla_image_prefix()
    mnt_r = await run_cmd(f"findmnt -n -o TARGET --source {device} | head -1", timeout=5)
    src_mnt = mnt_r["stdout"].strip()
    tmp_dir = None
    if not src_mnt:
        mk = await run_cmd("mktemp -d", timeout=5)
        tmp_dir = mk["stdout"].strip()
        m = await run_cmd(f"{_sudo('mount')} -o ro {device} {tmp_dir}", timeout=30)
        if m["returncode"] != 0:
            await run_cmd(f"rmdir {tmp_dir}", timeout=5)
            raise HTTPException(status_code=500, detail=f"{device} をマウントできませんでした: {m['stderr'].strip()}")
        src_mnt = tmp_dir
    try:
        ls = await run_cmd(
            f"find {src_mnt} -maxdepth 1 -type d -name '{prefix}-*' -printf '%f\\n' | LC_ALL=C sort",
            timeout=15,
        )
        return [line.strip() for line in ls["stdout"].splitlines() if line.strip()]
    finally:
        if tmp_dir:
            await run_cmd(f"{_sudo('umount')} {tmp_dir}; rmdir {tmp_dir}", timeout=15)


_SF_CLONEZILLA_BASE = "https://sourceforge.net/projects/clonezilla/files/clonezilla_live_stable"


async def _fetch_sf_listing(url: str) -> dict:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "cachyui"})
        resp = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req, timeout=15, context=_SSL_UNVERIFIED)
        )
        html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SourceForgeへの接続に失敗しました: {e}")
    m = re.search(r"net\.sf\.files\s*=\s*(\{.*?\});", html, re.S)
    if not m:
        raise HTTPException(status_code=502, detail="SourceForgeのページ解析に失敗しました")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="SourceForgeのデータ解析に失敗しました")


@app.get("/api/backup/clonezilla-versions")
async def clonezilla_versions():
    data = await _fetch_sf_listing(_SF_CLONEZILLA_BASE)
    versions = []
    for name, info in data.items():
        if info.get("type") == "d" and re.match(r"^\d+\.\d+", name):
            versions.append({"name": name})

    def _ver_key(v):
        parts = re.split(r"[.\-]", v["name"])
        return [int(p) for p in parts if p.isdigit()]
    versions.sort(key=_ver_key, reverse=True)
    return {"versions": versions}


@app.get("/api/backup/clonezilla-files")
async def clonezilla_files(version: str):
    if not re.match(r"^[\d.]+-\d+$", version):
        raise HTTPException(status_code=400, detail="不正なバージョン指定です")
    url = f"{_SF_CLONEZILLA_BASE}/{version}/"
    data = await _fetch_sf_listing(url)
    files = []
    for name, info in data.items():
        if info.get("type") == "f" and name.lower().endswith(".iso"):
            dl_url = f"{_SF_CLONEZILLA_BASE}/{version}/{name}/download"
            files.append({"name": name, "download_url": dl_url})
    files.sort(key=lambda f: f["name"])
    return {"files": files}


@app.post("/api/backup/clonezilla-download")
async def clonezilla_download(req: Request):
    data = await req.json()
    url = (data.get("url") or "").strip()
    filename = (data.get("filename") or "").strip()
    if not url or not filename:
        return {"success": False, "message": "URLとファイル名を指定してください"}
    if not re.match(r"^https?://sourceforge\.net/", url):
        return {"success": False, "message": "SourceForgeのURLを指定してください"}
    if not filename.lower().endswith(".iso"):
        return {"success": False, "message": "ISOファイルを指定してください"}
    return await _start_iso_download(url, filename)


@app.get("/api/backup/status")
async def backup_status():
    """Clonezilla ISO・/iso・Limine・SecureBoot の状態を返す。"""
    iso_path = await _find_clonezilla_iso()
    mnt = await run_cmd("findmnt -n -o SOURCE,FSTYPE,SIZE --target /iso", timeout=5)
    fields = mnt["stdout"].split()
    limine = await run_cmd("test -f /boot/limine.conf", timeout=5)
    sb = await run_cmd("mokutil --sb-state 2>/dev/null", timeout=5)
    secure_boot = "secureboot enabled" in sb["stdout"].strip().lower()
    return {
        "iso_found": bool(iso_path),
        "iso_path": iso_path,
        "iso_mounted": mnt["returncode"] == 0,
        "iso_source": fields[0] if len(fields) > 0 else None,
        "iso_fstype": fields[1] if len(fields) > 1 else None,
        "iso_size": fields[2] if len(fields) > 2 else None,
        "limine_present": limine["returncode"] == 0,
        "secure_boot": secure_boot,
    }


@app.get("/api/backup/partitions")
async def backup_partitions():
    partitions = await _list_clonezilla_partitions()
    return {"partitions": partitions}


@app.post("/api/backup/images")
async def backup_images(req: Request):
    data = await req.json()
    device = _validate_block_device(data.get("device", "").strip())
    images = await _list_clonezilla_images(device)
    return {"images": images, "prefix": _clonezilla_image_prefix()}


def _build_ocs_cmdline(base_cmdline: str, repo: str, ocs_run: str, revert_cmd: str = "") -> str:
    """Clonezilla 無人実行用 cmdline を組み立てる (toram 必須)。"""
    # 空の locales=/keyboard-layouts= を除去して明示値を付与
    base = re.sub(r"(^|\s)locales=\S*", r"\1", base_cmdline)
    base = re.sub(r"(^|\s)keyboard-layouts=\S*", r"\1", base)
    base = re.sub(r"\s+", " ", base).strip()
    base += " locales=en_US.UTF-8 keyboard-layouts=NONE"
    # 自動化で上書きする ocs_* を除去
    base = re.sub(r'ocs_[A-Za-z_]+="[^"]*"', "", base)
    base = re.sub(r"ocs_[A-Za-z_]+\S*", "", base)
    base = re.sub(r"\s+", " ", base).strip()
    prerun = f"mount {repo} /home/partimag"
    if revert_cmd:
        prerun += f" && {revert_cmd}"
    return (
        f"{base} toram ocs_lang=en_US.UTF-8 ocs_live_batch=\"yes\" "
        f"ocs_final_action=reboot ocs_prerun=\"{prerun}\" ocs_live_run=\"{ocs_run}\""
    )


def _build_default_revert_cmd(orig_default: str | None, had_default: bool) -> str:
    """ocs_prerun 先頭で default_entry を元に戻すシェル片を生成する。"""
    # /boot のデバイスを /mnt にマウントして limine.conf を書き戻す
    if had_default and orig_default:
        safe = orig_default.replace("'", "'\\''")
        sed_cmd = f"sed -i 's|^[[:space:]]*default_entry:.*|default_entry: {safe}|' /mnt/limine.conf"
    else:
        sed_cmd = "sed -i '/^[[:space:]]*default_entry:/d' /mnt/limine.conf"
    return "BOOTDEV=$(findmnt -n -o SOURCE /boot 2>/dev/null || findmnt -n -o SOURCE /) && mount -o rw $BOOTDEV /mnt && " + sed_cmd + " ; umount /mnt"


@app.post("/api/backup/run")
async def backup_run(req: Request):
    """Limine 方式で無人 Clonezilla 実行エントリを準備する。

    バックアップ時は default を linux-cachyos に固定 + remember 無効化し、
    手動で「ISO Boot > Clonezilla-AutoBackup」を選択して実行する。
    復元時は default を AutoRestore に一時設定し、ocs_prerun 先頭で元に戻す。
    """
    data = await req.json()
    mode = data.get("mode", "").strip()
    device = _validate_block_device(data.get("device", "").strip())
    image = (data.get("image") or "").strip()

    iso_path = await _find_clonezilla_iso()
    if not iso_path:
        raise HTTPException(status_code=400, detail=f"{CLONE_ISO_DIR} に {CLONE_ISO_GLOB} が見つかりません")
    mnt = await run_cmd("findmnt -n -o SOURCE --target /iso", timeout=5)
    if not mnt["stdout"].strip():
        raise HTTPException(status_code=500, detail="/iso がマウントされていません")

    prefix = _clonezilla_image_prefix()
    targets = await _system_target_parts()
    if not targets:
        raise HTTPException(status_code=500, detail="バックアップ対象パーティション (/ 等) を検出できませんでした")
    target_str = " ".join(targets)

    if mode == "backup":
        stub = AUTO_BACKUP_STUB
        images = await _list_clonezilla_images(device)
        img_name = f"{prefix}-{datetime.now().strftime('%Y-%m-%d')}"
        if img_name in images:
            img_name = f"{prefix}-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}"
        ocs_run = f"ocs-sr -q2 -j2 -z1p -sc -p reboot -batch saveparts {img_name} {target_str}"
        summary = f"保存先: {device} / イメージ: {img_name}"
    elif mode == "restore":
        stub = AUTO_RESTORE_STUB
        if not image:
            raise HTTPException(status_code=400, detail="image is required")
        if not re.fullmatch(rf"{re.escape(prefix)}-[A-Za-z0-9._-]+", image):
            raise HTTPException(status_code=400, detail="invalid image name")
        images = await _list_clonezilla_images(device)
        if image not in images:
            raise HTTPException(status_code=404, detail=f"イメージ {image} が {device} 上に見つかりません")
        ocs_run = f"ocs-sr -g auto -k -scr -p reboot -batch restoreparts {image} {target_str}"
        summary = f"復元元: {device} / イメージ: {image}"
    else:
        raise HTTPException(status_code=400, detail="mode must be 'backup' or 'restore'")

    # ISO 解析 + カーネル取り出し
    vmin, ird, btype, base_cmd = await _detect_limine_boot(iso_path)
    if btype != "live":
        raise HTTPException(status_code=500, detail="Clonezilla Live ISO (live 方式) を配置してください")
    iso_stub = os.path.basename(iso_path)
    if iso_stub.lower().endswith(".iso"):
        iso_stub = iso_stub[:-4]
    iso_stub = re.sub(r"[^A-Za-z0-9._-]+", "-", iso_stub).strip("-") or "clonezilla"
    await _limine_extract_kernel(iso_path, iso_stub, vmin, ird)

    lines = await _limine_load_lines()
    if lines is None:
        raise HTTPException(status_code=500, detail="/boot/limine.conf を読み取れませんでした")
    orig_default, had_default = _limine_get_default(lines)

    revert = ""
    if mode == "restore":
        revert = _build_default_revert_cmd(orig_default, had_default)

    cmdline = _build_ocs_cmdline(base_cmd, device, ocs_run, revert)
    entry = (
        f"{INDENT}//{stub}\n"
        f"{INDENT}comment: ISO: {os.path.basename(iso_path)}  (live, clonezilla-auto)\n"
        f"{INDENT}protocol: linux\n"
        f"{INDENT}module_path: boot():/{BOOT_ISO_SUBDIR}/{iso_stub}{ird}\n"
        f"{INDENT}path: boot():/{BOOT_ISO_SUBDIR}/{iso_stub}{vmin}\n"
        f"{INDENT}cmdline: {cmdline}\n"
    )
    bak = await _limine_backup()
    if not bak:
        raise HTTPException(status_code=500, detail="バックアップの作成に失敗しました")
    ok, err = await _limine_add_subentry(stub, entry)
    if not ok:
        raise HTTPException(status_code=500, detail=f"limine.confへの書き込みに失敗しました: {err}")

    if mode == "backup":
        # 前回起動エントリの記憶を無効化し、既定を linux-cachyos に固定
        lim_lines = await _limine_load_lines() or []
        title_idx = _limine_find_index_by_title(lim_lines, "linux-cachyos")
        if title_idx is not None:
            await _limine_set_default(str(title_idx))
        await _limine_set_remember("no")
        message = (
            f"{summary}\n準備完了。再起動後の Limine メニューで「ISO Boot > {stub}」を手動選択すると "
            f"Clonezilla Live が自動処理します\n対象: {target_str}\n"
            f"(既定を linux-cachyos に固定し、remember_last_entry を無効化しました)"
        )
    else:
        lim_lines = await _limine_load_lines() or []
        auto_idx = _limine_find_index_by_stub(lim_lines, stub)
        if auto_idx is not None:
            await _limine_set_default(str(auto_idx))
        message = (
            f"{summary}\n準備完了。再起動すると「ISO Boot > {stub}」が自動選択され、Clonezilla Live が "
            f"自動復元します (ocs_prerun 先頭で default_entry を元に戻します)\n対象: {target_str}"
        )
    return {"success": True, "message": message, "stub": stub}


@app.post("/api/cachyui/restart")
async def restart_cachyui():
    """Restart cachy-UI service."""
    async def do_restart():
        await asyncio.sleep(0.5)
        await run_cmd(_sudo("systemctl restart cachyui"), timeout=15)
    asyncio.create_task(do_restart())
    return {"success": True, "stdout": "Restarting...", "errors": ""}


# --- cachy-UI self-update ---
if os.getuid() == 0:
    CACHYUI_UPDATE_LOG = "/var/log/cachyui-update.log"
    CACHYUI_UPDATE_PID = "/run/cachyui-update.pid"
else:
    CACHYUI_UPDATE_LOG = f"/tmp/cachyui-update-{os.getuid()}.log"
    CACHYUI_UPDATE_PID = f"/tmp/cachyui-update-{os.getuid()}.pid"


@app.post("/api/system/selfupdate")
async def system_selfupdate():
    """Start cachy-UI self-update as a detached process.

    The updater runs independently of this server, so it always finishes
    even though the files being replaced belong to the running service.
    Applying the new version (service restart) is done manually by the user.
    """
    try:
        with open(CACHYUI_UPDATE_PID) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return {"success": False, "message": "アップデートが既に実行中です"}
    except FileNotFoundError:
        pass
    except (ValueError, ProcessLookupError):
        pass
    except PermissionError:
        return {"success": False, "message": "アップデートが既に実行中です"}

    script = "\n".join([
        "set -e",
        f"echo $$ > {CACHYUI_UPDATE_PID}",
        f"trap 'rm -f {CACHYUI_UPDATE_PID}' EXIT",
        f"exec > {CACHYUI_UPDATE_LOG} 2>&1",
        'echo "[cachy-UI update] start $(date)"',
        "rm -rf /tmp/cachyui-update",
        "git clone --depth 1 https://github.com/hirogura/cachyos-cachyui.git /tmp/cachyui-update",
        "bash /tmp/cachyui-update/setup.sh --no-restart",
        'echo "[cachy-UI update] done $(date)"',
        "echo __CACHYUI_UPDATE_DONE__",
    ]) + "\n"

    await asyncio.create_subprocess_exec(
        "/bin/bash", "-c", script,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"success": True, "message": "アップデートを開始しました"}


@app.get("/api/system/selfupdate/status")
async def system_selfupdate_status():
    """Return current self-update progress (running flag + log tail)."""
    running = False
    try:
        with open(CACHYUI_UPDATE_PID) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        running = True
    except Exception:
        running = False

    log_tail = ""
    done = False
    try:
        with open(CACHYUI_UPDATE_LOG, errors="replace") as f:
            content = f.read()
        done = "__CACHYUI_UPDATE_DONE__" in content
        log_tail = content[-3000:]
    except OSError:
        pass

    return {"running": running, "done": done, "log": log_tail}


@app.post("/api/system/reboot")
async def reboot_system():
    """Reboot the host system."""
    async def do_reboot():
        await asyncio.sleep(1.0)
        await run_cmd(f"{_sudo('/usr/bin/systemctl reboot')} || {_sudo('/usr/sbin/reboot')} || {_sudo('/sbin/reboot')} || {_sudo('reboot')}", timeout=15)
    asyncio.create_task(do_reboot())
    return {"success": True, "message": "システムを再起動しています..."}


@app.post("/api/system/shutdown")
async def shutdown_system():
    """Shut down the host system."""
    async def do_shutdown():
        await asyncio.sleep(1.0)
        await run_cmd(f"{_sudo('/usr/bin/systemctl poweroff')} || {_sudo('/usr/sbin/poweroff')} || {_sudo('/sbin/poweroff')} || {_sudo('poweroff')}", timeout=15)
    asyncio.create_task(do_shutdown())
    return {"success": True, "message": "システムをシャットダウンしています..."}


# ============================================================
# ============================================================
# 8. Limine 管理 (cachy-isoboot 方式 / create-isopart 連携)
# ============================================================
# Limine には GRUB の loopback 機能が無いため、/iso の ISO から
# vmlinuz / initramfs を /boot/isos/<名前>/ に取り出して
# /boot/limine.conf の「/+ISO Boot」セクションにサブエントリを追加する。
# 対応ブート方式: archiso / casper / live (Debian/Clonezilla)
LIMINE_CONF = "/boot/limine.conf"
LIMINE_BACKUP_DIR = "/root/limine-boot-backups"
BOOT_ISO_SUBDIR = "isos"
MENU_SECTION = "/+ISO Boot"
INDENT = "  "
ISO_DIR = "/iso"


async def _read_text(path: str) -> str | None:
    """ファイルを読み取る。権限が無ければ sudo cat で代替する。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except PermissionError:
        res = await run_cmd(_sudo(f"cat {shlex.quote(path)}"))
        return res["stdout"] if res["returncode"] == 0 else None
    except OSError:
        return None


async def _write_root_file(path: str, content: str) -> tuple[bool, str]:
    """root 権限が必要なファイルを書き込む。"""
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return True, ""
    except PermissionError:
        fd, tmp = tempfile.mkstemp(prefix="cachyui_limine_", dir="/tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        try:
            res = await run_cmd(_sudo(f"cp {shlex.quote(tmp)} {shlex.quote(path)}"))
            return res["returncode"] == 0, res["stderr"]
        finally:
            os.unlink(tmp)


async def _efi_entries() -> list[dict]:
    which = await run_cmd("which efibootmgr")
    if which["returncode"] != 0:
        return []
    res = await run_cmd(_sudo("efibootmgr"), timeout=10)
    out = []
    for line in res["stdout"].splitlines():
        line = line.rstrip()
        if not line:
            continue
        out.append({"text": line, "active": line.startswith("*")})
    return out


def _limine_backup_name() -> str:
    return f"{LIMINE_BACKUP_DIR}/limine.conf.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"


async def _limine_backup() -> str | None:
    dst = _limine_backup_name()
    await run_cmd(_sudo(f"mkdir -p {shlex.quote(LIMINE_BACKUP_DIR)}"))
    res = await run_cmd(_sudo(f"cp {shlex.quote(LIMINE_CONF)} {shlex.quote(dst)}"))
    return dst if res["returncode"] == 0 else None


def _limine_load_lines() -> list[str] | None:
    try:
        with open(LIMINE_CONF, encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except OSError:
        return None


async def _limine_load_lines() -> list[str] | None:
    txt = await _read_text(LIMINE_CONF)
    return txt.splitlines() if txt is not None else None


async def _limine_flush_lines(lines: list[str]) -> tuple[bool, str]:
    out: list[str] = []
    prev_empty = False
    for line in lines:
        if line == "":
            if prev_empty:
                continue
            prev_empty = True
        else:
            prev_empty = False
        out.append(line)
    while out and out[-1] == "":
        out.pop()
    content = "\n".join(out) + "\n"
    return await _write_root_file(LIMINE_CONF, content)


def _limine_find_section(lines: list[str]) -> int:
    for i, line in enumerate(lines):
        if line == MENU_SECTION:
            return i
    return -1


def _limine_content_end(lines: list[str], hdr: int) -> int:
    for i in range(hdr + 1, len(lines)):
        line = lines[i]
        if line != "" and not line[:1].isspace():
            return i
    return len(lines)


def _limine_scan_children(lines: list[str], hdr: int, end: int) -> tuple[list[str], list[int], list[int]]:
    stubs: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for i in range(hdr + 1, end):
        m = re.match(r"^\s*//(.+?)\s*$", lines[i])
        if not m:
            continue
        stubs.append(m.group(1).strip())
        starts.append(i)
        if len(starts) > 1:
            ends.append(i)
    if starts:
        ends.append(end)
    return stubs, starts, ends


async def _limine_add_subentry(stub: str, block_text: str) -> tuple[bool, str]:
    lines = await _limine_load_lines()
    if lines is None:
        return False, f"{LIMINE_CONF} を読み取れませんでした"
    block = block_text.strip("\n").splitlines()
    hdr = _limine_find_section(lines)
    if hdr >= 0:
        end = _limine_content_end(lines, hdr)
        stubs, starts, ends = _limine_scan_children(lines, hdr, end)
        for k, s in enumerate(stubs):
            if s == stub:
                del lines[starts[k]:ends[k]]
                break
        end = _limine_content_end(lines, _limine_find_section(lines))
        lines[end:end] = block
    else:
        if lines:
            lines.append("")
        lines.append(MENU_SECTION)
        lines.extend(block)
    return await _limine_flush_lines(lines)


async def _limine_remove_subentries(stubs: list[str]) -> tuple[int, str]:
    lines = await _limine_load_lines()
    if lines is None:
        return 0, f"{LIMINE_CONF} を読み取れませんでした"
    hdr = _limine_find_section(lines)
    if hdr < 0:
        return 0, ""
    end = _limine_content_end(lines, hdr)
    cur_stubs, starts, ends = _limine_scan_children(lines, hdr, end)
    todel = sorted([k for k, s in enumerate(cur_stubs) if s in stubs], reverse=True)
    for k in todel:
        del lines[starts[k]:ends[k]]
    # 子が残っていなければセクションごと撤去
    hdr2 = _limine_find_section(lines)
    if hdr2 >= 0:
        end2 = _limine_content_end(lines, hdr2)
        s2, _, _ = _limine_scan_children(lines, hdr2, end2)
        if not s2:
            del lines[hdr2:hdr2 + 1]
    ok, err = await _limine_flush_lines(lines)
    return (len(todel) if ok else 0), err


def _limine_parse_entries(lines: list[str]) -> list[dict]:
    """Limine エントリ一覧をパースする (1始まりの番号付き)。"""
    entries: list[dict] = []
    idx = 0
    for line in lines:
        stripped = line.lstrip()
        if not stripped.startswith("/"):
            continue
        idx += 1
        name = stripped.lstrip("/").lstrip("+")
        kind = "dir" if stripped.startswith("/+") else ("sub" if stripped.startswith("//") else "entry")
        entries.append({"index": idx, "name": name, "kind": kind, "raw": stripped})
    return entries


def _limine_get_default(lines: list[str]) -> tuple[str | None, bool]:
    for line in lines:
        m = re.match(r"^\s*default_entry\s*:\s*(.+?)\s*(?:#.*)?$", line, re.I)
        if m:
            return m.group(1).strip(), True
    return None, False


async def _limine_set_default(value: str) -> tuple[bool, str]:
    lines = await _limine_load_lines()
    if lines is None:
        return False, f"{LIMINE_CONF} を読み取れませんでした"
    done = False
    for i, line in enumerate(lines):
        if re.match(r"^\s*default_entry\s*:", line, re.I):
            lines[i] = f"default_entry: {value}"
            done = True
            break
    if not done:
        lines.insert(0, f"default_entry: {value}")
    return await _limine_flush_lines(lines)


async def _limine_set_remember(value: str) -> tuple[bool, str]:
    lines = await _limine_load_lines()
    if lines is None:
        return False, f"{LIMINE_CONF} を読み取れませんでした"
    done = False
    for i, line in enumerate(lines):
        if re.match(r"^\s*remember_last_entry\s*:", line, re.I):
            lines[i] = f"remember_last_entry: {value}"
            done = True
            break
    if not done:
        lines.insert(0, f"remember_last_entry: {value}")
    return await _limine_flush_lines(lines)


def _limine_find_index_by_stub(lines: list[str], stub: str) -> int | None:
    idx = 0
    for line in lines:
        stripped = line.lstrip()
        if not stripped.startswith("/"):
            continue
        idx += 1
        if stripped.strip() == f"//{stub}":
            return idx
    return None


def _limine_find_index_by_title(lines: list[str], title: str) -> int | None:
    idx = 0
    for line in lines:
        stripped = line.lstrip()
        if not stripped.startswith("/"):
            continue
        idx += 1
        name = stripped.lstrip("/").lstrip("+")
        if name == title:
            return idx
    return None


def _limine_archiso_to_loop(iso: str, cmdline: str) -> str:
    """archiso パラメータを img_dev/img_loop 方式に変換する。"""
    try:
        dev_r = subprocess.run(["findmnt", "-no", "SOURCE", "--target", iso],
                               capture_output=True, text=True, timeout=5)
        mp_r = subprocess.run(["findmnt", "-no", "TARGET", "--target", iso],
                              capture_output=True, text=True, timeout=5)
        dev, mp = dev_r.stdout.strip(), mp_r.stdout.strip()
    except Exception:
        return cmdline
    if "[" in dev and "]" in dev:
        dev = dev.split("[")[0]
    if not dev or not mp or iso == mp or not iso.startswith(mp + "/"):
        return cmdline
    rel = iso[len(mp) + 1:].lstrip("/")
    try:
        ur = subprocess.run(["blkid", "-p", "-o", "value", "-s", "UUID", dev],
                            capture_output=True, text=True, timeout=5)
        uuid = ur.stdout.strip()
        loop_dev = f"/dev/disk/by-uuid/{uuid}" if uuid else dev
    except Exception:
        loop_dev = dev
    out = re.sub(r"(archisosearchuuid|archisosearchfilename|archisolabel|archisodevice)=[^\\s]+", "", cmdline)
    return f"{out} img_dev={loop_dev} img_loop=/{rel}".strip()


def _limine_live_to_loop(iso: str, cmdline: str) -> str:
    """live (Debian/Clonezilla) パラメータを live-media/findiso 方式に変換する。"""
    out = re.sub(r"(findiso|fromiso|live-media|bootfrom)=[^\\s]+", "", cmdline)
    try:
        dev_r = subprocess.run(["findmnt", "-no", "SOURCE", "--target", iso],
                               capture_output=True, text=True, timeout=5)
        mp_r = subprocess.run(["findmnt", "-no", "TARGET", "--target", iso],
                              capture_output=True, text=True, timeout=5)
        dev, mp = dev_r.stdout.strip(), mp_r.stdout.strip()
    except Exception:
        return out.strip()
    if not dev or not mp or iso == mp or not iso.startswith(mp + "/"):
        return out.strip()
    rel = iso[len(mp) + 1:].lstrip("/")
    if "[" in dev and "]" in dev:
        dev = dev.split("[")[0]
    live_dev = dev if dev.startswith("/dev/") else ""
    if not live_dev:
        return f"{out} findiso={rel}".strip()
    return f"{out} live-media={live_dev} findiso={rel}".strip()


async def _detect_limine_boot(iso_path: str) -> tuple[str, str, str, str]:
    """ISO をループマウントして vmlinuz/initrd/方式/ベースcmdline を検出する。

    戻り値: (vmlinuz, initrd, boot_type, base_cmdline)
    boot_type は archiso / casper / live のいずれか。
    """
    tmp = f"/mnt/_cachyui_isoinspect_{os.getpid()}"
    await run_cmd(_sudo(f"mkdir -p {shlex.quote(tmp)}"))
    mounted = False
    try:
        mres = await run_cmd(_sudo(f"mount -o loop,ro {shlex.quote(iso_path)} {shlex.quote(tmp)}"), timeout=30)
        if mres["returncode"] != 0:
            raise HTTPException(status_code=500, detail=f"ISOをマウントできませんでした: {iso_path}")
        mounted = True

        def _exists(rel: str) -> bool:
            r = subprocess.run(["test", "-f", tmp + rel], timeout=5)
            return r.returncode == 0

        # --- archiso ---
        arch_kernel = ""
        for cand_dir in (f"{tmp}/arch/boot/x86_64", f"{tmp}/arch/boot"):
            try:
                for fn in sorted(os.listdir(cand_dir)):
                    if fn.startswith("vmlinuz"):
                        arch_kernel = f"{cand_dir}/{fn}"
                        break
                if arch_kernel:
                    break
            except OSError:
                continue
        if arch_kernel:
            kdir = os.path.dirname(arch_kernel)
            kbase = os.path.basename(arch_kernel)
            kname = kbase[8:] if kbase.startswith("vmlinuz-") else kbase
            initrd = ""
            for cand in (f"{kdir}/initramfs-{kname}.img",):
                if os.path.isfile(cand):
                    initrd = cand
                    break
            if not initrd:
                try:
                    for fn in sorted(os.listdir(kdir)):
                        if fn.startswith("initramfs") or fn.startswith("initrd"):
                            initrd = f"{kdir}/{fn}"
                            break
                except OSError:
                    pass
            if not initrd:
                raise HTTPException(status_code=500, detail="archiso の initramfs が見つかりません")
            vmlinuz_rel = arch_kernel[len(tmp):]
            initrd_rel = initrd[len(tmp):]
            cmdline = ""
            for cfg in ("boot/grub/grub.cfg", "boot/syslinux/archiso_sys-linux.cfg",
                        "boot/syslinux/archiso_sys.cfg", "arch/boot/syslinux/archiso_sys-linux.cfg"):
                cfg_p = os.path.join(tmp, cfg)
                if not os.path.isfile(cfg_p):
                    continue
                try:
                    with open(cfg_p, errors="replace") as f:
                        txt = f.read()
                    m = re.search(r"^\s*linux\s+/arch/\S+\s+(.+)$", txt, re.M)
                    if m:
                        cmdline = m.group(1)
                        break
                    m = re.search(r"^APPEND\s+(.+archiso.+)$", txt, re.M)
                    if m:
                        cmdline = m.group(1)
                        break
                except OSError:
                    continue
            if not cmdline or "$" in cmdline:
                cmdline = "archisobasedir=arch quiet splash"
            cmdline = _limine_archiso_to_loop(iso_path, cmdline)
            return vmlinuz_rel, initrd_rel, "archiso", cmdline.strip()

        # --- casper (Ubuntu系) ---
        if _exists("/casper/vmlinuz"):
            initrd = "/casper/initrd"
            for cand in ("/casper/initrd", "/casper/initrd.lz", "/casper/initrd.img"):
                if _exists(cand):
                    initrd = cand
                    break
            iso_abs = os.path.realpath(iso_path)
            return "/casper/vmlinuz", initrd, "casper", f"boot=casper iso-scan/filename={iso_abs} quiet splash ---"

        # --- live (Debian/Clonezilla) ---
        if _exists("/live/vmlinuz"):
            initrd = "/live/initrd.img" if _exists("/live/initrd.img") else "/live/initrd"
            live_cmd = ""
            for cfg in ("boot/grub/grub.cfg", "syslinux/isolinux.cfg", "syslinux/syslinux.cfg"):
                cfg_p = os.path.join(tmp, cfg)
                if not os.path.isfile(cfg_p):
                    continue
                try:
                    with open(cfg_p, errors="replace") as f:
                        txt = f.read()
                    m = re.search(r"^\s*(?:\$linux_cmd|linuxefi|linux)\s+/live/vmlinuz\s+(.+)$", txt, re.M)
                    if m:
                        live_cmd = re.sub(r"\s*initrd=\S+", "", m.group(1)).strip()
                        break
                    m = re.search(r"^\s*append\s+(.+boot=live.+)$", txt, re.M | re.I)
                    if m:
                        live_cmd = re.sub(r"\s*initrd=\S+", "", m.group(1)).strip()
                        break
                except OSError:
                    continue
            if not live_cmd or "$" in live_cmd:
                live_cmd = "boot=live config components union=overlay quiet splash"
            live_cmd = _limine_live_to_loop(iso_path, live_cmd)
            return "/live/vmlinuz", initrd, "live", live_cmd.strip()

        raise HTTPException(status_code=500, detail="対応ブート方式を検出できません (archiso/casper/live のみ対応)")
    finally:
        if mounted:
            await run_cmd(_sudo(f"umount {shlex.quote(tmp)}"), timeout=15)
        await run_cmd(_sudo(f"rmdir {shlex.quote(tmp)} 2>/dev/null"))


async def _limine_extract_kernel(iso_path: str, stub: str, vmlinuz_rel: str, initrd_rel: str) -> None:
    """ISO から vmlinuz/initramfs を /boot/isos/<stub>/ に取り出す。"""
    dst = f"/boot/{BOOT_ISO_SUBDIR}/{stub}"
    chk = await run_cmd(f"test -f {shlex.quote(dst + vmlinuz_rel)} -a -f {shlex.quote(dst + initrd_rel)}", timeout=5)
    if chk["returncode"] == 0:
        return
    tmp = f"/mnt/_cachyui_isoextract_{os.getpid()}"
    await run_cmd(_sudo(f"mkdir -p {shlex.quote(tmp)}"))
    mounted = False
    try:
        mres = await run_cmd(_sudo(f"mount -o loop,ro {shlex.quote(iso_path)} {shlex.quote(tmp)}"), timeout=30)
        if mres["returncode"] != 0:
            raise HTTPException(status_code=500, detail="ISOをマウントできませんでした")
        mounted = True
        await run_cmd(_sudo(f"mkdir -p {shlex.quote(dst + '/' + os.path.dirname(vmlinuz_rel.strip('/')))} {shlex.quote(dst + '/' + os.path.dirname(initrd_rel.strip('/')))}"), timeout=10)
        c1 = await run_cmd(_sudo(f"cp {shlex.quote(tmp + vmlinuz_rel)} {shlex.quote(dst + vmlinuz_rel)}"), timeout=120)
        c2 = await run_cmd(_sudo(f"cp {shlex.quote(tmp + initrd_rel)} {shlex.quote(dst + initrd_rel)}"), timeout=120)
        if c1["returncode"] != 0 or c2["returncode"] != 0:
            raise HTTPException(status_code=500, detail="カーネル取り出しに失敗しました")
    finally:
        if mounted:
            await run_cmd(_sudo(f"umount {shlex.quote(tmp)}"), timeout=15)
        await run_cmd(_sudo(f"rmdir {shlex.quote(tmp)} 2>/dev/null"))


def _limine_build_entry(stub: str, iso_rel: str, vmlinuz_rel: str, initrd_rel: str,
                        cmdline: str, boot_type: str) -> str:
    return (
        f"{INDENT}//{stub}\n"
        f"{INDENT}comment: ISO: {iso_rel}  ({boot_type})\n"
        f"{INDENT}protocol: linux\n"
        f"{INDENT}module_path: boot():/{BOOT_ISO_SUBDIR}/{stub}{initrd_rel}\n"
        f"{INDENT}path: boot():/{BOOT_ISO_SUBDIR}/{stub}{vmlinuz_rel}\n"
        f"{INDENT}cmdline: {cmdline}\n"
    )


def _validate_limine_path(p: str) -> bool:
    if not p.startswith("/"):
        return False
    if ".." in p.split("/"):
        return False
    return not any(ch in p for ch in ('"', "'", "`", "\\", "\n", "\r", "$", ";", "&", "|", "<", ">"))


@app.get("/api/limine/info")
async def limine_info():
    """Limine 設定・エントリー一覧・EFI・/iso 状態を返す。"""
    lines = await _limine_load_lines()
    if lines is None:
        return {"exists": False, "conf": LIMINE_CONF, "entries": [],
                "efi": await _efi_entries(), "error": f"{LIMINE_CONF} が見つかりません"}
    entries = _limine_parse_entries(lines)
    default_val, has_default = _limine_get_default(lines)
    remember = None
    for line in lines:
        m = re.match(r"^\s*remember_last_entry\s*:\s*(.+?)\s*(?:#.*)?$", line, re.I)
        if m:
            remember = m.group(1).strip()
            break
    hdr = _limine_find_section(lines)
    iso_entries: list[str] = []
    if hdr >= 0:
        end = _limine_content_end(lines, hdr)
        iso_entries, _, _ = _limine_scan_children(lines, hdr, end)
    mnt = await run_cmd("findmnt -n -o SOURCE,FSTYPE,SIZE --target /iso", timeout=5)
    fields = mnt["stdout"].split()
    return {
        "exists": True,
        "conf": LIMINE_CONF,
        "entries": entries,
        "default_entry": default_val,
        "has_default": has_default,
        "remember_last_entry": remember,
        "iso_boot_entries": iso_entries,
        "iso_mounted": mnt["returncode"] == 0,
        "iso_source": fields[0] if len(fields) > 0 else None,
        "iso_fstype": fields[1] if len(fields) > 1 else None,
        "iso_size": fields[2] if len(fields) > 2 else None,
        "efi": await _efi_entries(),
    }


@app.get("/api/limine/isos")
async def limine_isos():
    """/iso 直下の ISO を一覧し、ブート方式を自動検出する。"""
    mnt = await run_cmd("findmnt -n --target /iso", timeout=5)
    if mnt["returncode"] != 0:
        return {"success": False, "error": "/iso に保存用パーティションがマウントされていません (create-isopart で作成してください)", "isos": []}
    fres = await run_cmd("find /iso -maxdepth 1 -name '*.iso' 2>/dev/null | LC_ALL=C sort", timeout=15)
    paths = [l.strip() for l in fres["stdout"].splitlines() if l.strip()]
    isos = []
    for full in paths:
        sz = await run_cmd(f"du -sh {shlex.quote(full)} 2>/dev/null | cut -f1", timeout=10)
        try:
            vmin, ird, btype, _ = await _detect_limine_boot(full)
        except HTTPException as e:
            vmin, ird, btype = "UNKNOWN", "UNKNOWN", "unknown"
            _ = e
        isos.append({"path": full, "name": os.path.basename(full),
                     "size": sz["stdout"].strip(), "vmlinuz": vmin, "initrd": ird, "boot_type": btype})
    return {"success": True, "isos": isos}


@app.get("/api/limine/isopart/status")
async def limine_isopart_status():
    """/iso マウント状態と btrfs パーティション構成を返す (create-isopart 用)。"""
    mnt = await run_cmd("findmnt -n -o SOURCE,FSTYPE,SIZE,TARGET --target /iso", timeout=5)
    disks = await run_cmd("lsblk -rno NAME,FSTYPE,SIZE,MOUNTPOINT,TYPE | awk '$2==\"btrfs\"'", timeout=10)
    return {
        "iso_mounted": mnt["returncode"] == 0,
        "iso_info": mnt["stdout"].strip(),
        "btrfs_parts": [l.strip() for l in disks["stdout"].splitlines() if l.strip()],
    }


@app.post("/api/limine/entries/add")
async def limine_entries_add(req: Request):
    """ISO からカーネルを取り出して Limine の ISO Boot エントリを追加する。"""
    data = await req.json()
    isos = data.get("isos") or []
    if not isinstance(isos, list) or not isos:
        raise HTTPException(status_code=400, detail="isos are required")
    added: list[str] = []
    bak = await _limine_backup()
    if not bak:
        return {"success": False, "message": "バックアップの作成に失敗しました"}
    for item in isos:
        full = str(item.get("path", "")).strip()
        if not full.startswith("/iso/"):
            return {"success": False, "message": f"/iso 配下のISOを指定してください: {full}"}
        if not os.path.isfile(full):
            return {"success": False, "message": f"ISOが見つかりません: {full}"}
        stub = os.path.basename(full)
        if stub.lower().endswith(".iso"):
            stub = stub[:-4]
        stub = re.sub(r"[^A-Za-z0-9._-]+", "-", stub).strip("-") or "iso"
        vmin, ird, btype, base_cmd = await _detect_limine_boot(full)
        await _limine_extract_kernel(full, stub, vmin, ird)
        iso_rel = os.path.basename(full)
        entry = _limine_build_entry(stub, iso_rel, vmin, ird, base_cmd, btype)
        ok, err = await _limine_add_subentry(stub, entry)
        if not ok:
            return {"success": False, "message": f"Limineへの書き込みに失敗しました: {err}"}
        added.append(stub)
    msg = f"{len(added)}件のISOブートエントリーを追加しました ({', '.join(added)})\nバックアップ: {bak}\nlimine.conf は即時反映されます。再起動後の Limine メニュー「ISO Boot」から選択してください。"
    return {"success": True, "message": msg, "entries": added}


@app.post("/api/limine/entries/delete")
async def limine_entries_delete(req: Request):
    """ISO Boot サブエントリを削除する (stub 名指定)。"""
    data = await req.json()
    stubs = data.get("stubs") or data.get("entries") or []
    if not isinstance(stubs, list) or not stubs:
        raise HTTPException(status_code=400, detail="stubs are required")
    clean = [re.sub(r"[^A-Za-z0-9._-]+", "-", str(s)) for s in stubs]
    bak = await _limine_backup()
    if not bak:
        return {"success": False, "message": "バックアップの作成に失敗しました"}
    removed, err = await _limine_remove_subentries(clean)
    if err:
        return {"success": False, "message": f"削除に失敗しました: {err}"}
    return {"success": True, "message": f"{removed}件削除しました\nバックアップ: {bak}"}


@app.post("/api/limine/default")
async def limine_set_default(req: Request):
    """次回起動エントリ (default_entry) を設定する。"""
    data = await req.json()
    value = str(data.get("value", "")).strip()
    if not value:
        raise HTTPException(status_code=400, detail="value is required")
    if not re.fullmatch(r"[A-Za-z0-9_+\-/ ]+", value):
        raise HTTPException(status_code=400, detail="invalid value")
    bak = await _limine_backup()
    ok, err = await _limine_set_default(value)
    if not ok:
        return {"success": False, "message": f"default_entry の変更に失敗しました: {err}"}
    return {"success": True, "message": f"default_entry を {value} に設定しました\nバックアップ: {bak}"}


# --- ISO ダウンロード (Limine /iso 用・汎用) ---
_iso_dl_state: dict = {
    "running": False, "success": None, "cancelled": False,
    "log": "", "filename": "", "path": "", "total": None,
}
_iso_dl_lock = asyncio.Lock()
_iso_dl_proc: asyncio.subprocess.Process | None = None


def _reset_iso_dl_state(**kw) -> None:
    _iso_dl_state.clear()
    _iso_dl_state.update({
        "running": False, "success": None, "cancelled": False,
        "log": "", "filename": "", "path": "", "total": None,
    }, **kw)


def _probe_content_length(url: str) -> int | None:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "cachyui"})
        with urllib.request.urlopen(req, timeout=5, context=_SSL_UNVERIFIED) as resp:
            cl = resp.headers.get("Content-Length")
            return int(cl) if cl else None
    except Exception:
        return None


async def _iso_download_worker(proc: asyncio.subprocess.Process, dest: str) -> None:
    global _iso_dl_proc
    try:
        _, stderr = await proc.communicate()
        rc = proc.returncode
        async with _iso_dl_lock:
            if rc == 0:
                _iso_dl_state["success"] = True
                _iso_dl_state["log"] = ""
            else:
                _iso_dl_state["success"] = False
                if _iso_dl_state["cancelled"]:
                    _iso_dl_state["log"] = "キャンセルしました"
                else:
                    err_lines = [l for l in stderr.decode("utf-8", errors="replace").splitlines() if l.strip()]
                    _iso_dl_state["log"] = err_lines[-1] if err_lines else f"wget exit code {rc}"
                await run_cmd(_sudo(f"rm -f {shlex.quote(dest)}"))
            _iso_dl_state["running"] = False
    except Exception as e:
        async with _iso_dl_lock:
            _iso_dl_state["success"] = False
            _iso_dl_state["log"] = str(e)
            _iso_dl_state["running"] = False
    finally:
        _iso_dl_proc = None


async def _start_iso_download(url: str, filename: str) -> dict:
    global _iso_dl_proc
    if not re.match(r"^https?://", url):
        return {"success": False, "message": "http:// または https:// で始まるURLを入力してください"}
    if any(ch in filename for ch in ('"', "'", "`", "\\", "$", ";", "&", "|", "<", ">")):
        return {"success": False, "message": "ファイル名に使用できない文字が含まれています"}
    w = await run_cmd("which wget")
    if w["returncode"] != 0:
        return {"success": False, "message": "wget が見つかりません (sudo pacman -S wget)"}
    mnt = await run_cmd("findmnt -n --target /iso", timeout=5)
    if mnt["returncode"] != 0:
        return {"success": False, "message": "/iso に保存用パーティションがマウントされていません"}
    dest = f"/iso/{filename}"
    if os.path.exists(dest):
        return {"success": False, "message": f"同名のファイルが既に存在します: {filename}"}
    total = await asyncio.to_thread(_probe_content_length, url)
    async with _iso_dl_lock:
        if _iso_dl_state["running"]:
            return {"success": False, "message": "ダウンロードが既に実行中です"}
        proc = await asyncio.create_subprocess_shell(
            _sudo(f"wget -q --tries=3 --timeout=60 -O {shlex.quote(dest)} {shlex.quote(url)}"),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _iso_dl_proc = proc
        _reset_iso_dl_state(running=True, filename=filename, path=dest, total=total)
        asyncio.create_task(_iso_download_worker(proc, dest))
    return {"success": True, "filename": filename}


@app.post("/api/limine/iso-download")
async def limine_iso_download(req: Request):
    """/iso へ汎用 ISO をダウンロードする。"""
    data = await req.json()
    url = (data.get("url") or "").strip()
    if not url:
        return {"success": False, "message": "ISOイメージのURLを入力してください"}
    if any(ch in url for ch in ('"', "'", "`", "\\", "\n", "\r", "$", ";", "&", "|", "<", ">")):
        return {"success": False, "message": "URLに使用できない文字が含まれています"}
    fname = os.path.basename(urllib.parse.urlparse(url).path)
    if not fname.lower().endswith(".iso"):
        return {"success": False, "message": "URLの末尾が.isoとなっている直接リンクを指定してください"}
    return await _start_iso_download(url, fname)


@app.get("/api/limine/iso-download/status")
async def limine_iso_download_status():
    st = dict(_iso_dl_state)
    size = 0
    try:
        if st["path"] and os.path.isfile(st["path"]):
            size = os.path.getsize(st["path"])
    except OSError:
        size = 0
    st["size"] = size
    st.pop("path", None)
    return st


@app.post("/api/limine/iso-download/cancel")
async def limine_iso_download_cancel():
    async with _iso_dl_lock:
        if not _iso_dl_state["running"]:
            return {"success": False, "message": "実行中のダウンロードはありません"}
        _iso_dl_state["cancelled"] = True
        proc = _iso_dl_proc
    if proc is not None and proc.returncode is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    return {"success": True, "message": "ダウンロードをキャンセルしています..."}


# --- CachyOS ISO 一覧 (build.cachyos.org ミラー) ---
_CACHYOS_ISO_BASE = "https://build.cachyos.org/ISO"
_CACHYOS_EDITIONS = ["desktop", "kde", "handheld", "cli"]


@app.get("/api/limine/cachyos-editions")
async def cachyos_editions():
    return {"editions": _CACHYOS_EDITIONS}


@app.get("/api/limine/cachyos-files")
async def cachyos_files(edition: str = "desktop"):
    """指定エディションの最新 ISO 一覧をミラーから取得する。"""
    if edition not in _CACHYOS_EDITIONS:
        raise HTTPException(status_code=400, detail="不正なエディション指定です")
    base = f"{_CACHYOS_ISO_BASE}/{edition}/"
    try:
        req = urllib.request.Request(base, headers={"User-Agent": "cachyui"})
        resp = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req, timeout=15, context=_SSL_UNVERIFIED)
        )
        html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"CachyOSミラーへの接続に失敗しました: {e}")
    dates = sorted(set(re.findall(r'href="(\d{6})/"', html)), reverse=True)
    if not dates:
        return {"files": [], "edition": edition}
    latest = dates[0]
    dir_url = f"{base}{latest}/"
    try:
        req2 = urllib.request.Request(dir_url, headers={"User-Agent": "cachyui"})
        resp2 = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req2, timeout=15, context=_SSL_UNVERIFIED)
        )
        html2 = resp2.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"CachyOSミラーへの接続に失敗しました: {e}")
    files = []
    for name in sorted(set(re.findall(r'href="((?:cachyos-)?[^"]*\.iso)"', html2))):
        if name.endswith((".sha1", ".sha256", ".sig")):
            continue
        files.append({"name": name, "download_url": f"{dir_url}{name}", "date": latest})
    return {"files": files, "edition": edition, "date": latest}


@app.post("/api/limine/cachyos-download")
async def cachyos_download(req: Request):
    data = await req.json()
    url = (data.get("url") or "").strip()
    filename = (data.get("filename") or "").strip()
    if not url or not filename:
        return {"success": False, "message": "URLとファイル名を指定してください"}
    if not url.startswith(_CACHYOS_ISO_BASE):
        return {"success": False, "message": "CachyOSミラーのURLを指定してください"}
    if not filename.lower().endswith(".iso"):
        return {"success": False, "message": "ISOファイルを指定してください"}
    return await _start_iso_download(url, filename)


# ============================================================
# 8.5 Snapper スナップショット管理
# ============================================================
SNAPPER_CONFIG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
SNAPPER_CLEANUP_VALUES = {"number", "timeline", "empty"}


def _validate_snapper_config(config: str) -> str:
    """snapper設定名を検証する (既定は root)。"""
    config = (config or "").strip() or "root"
    if not SNAPPER_CONFIG_RE.fullmatch(config):
        raise HTTPException(status_code=400, detail="invalid config name")
    return config


def _validate_snapshot_number(number) -> int:
    try:
        n = int(number)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid snapshot number")
    if n < 0:
        raise HTTPException(status_code=400, detail="invalid snapshot number")
    return n


def _parse_snapper_list_csv(stdout: str) -> list[dict] | None:
    """snapper --csvout list の出力をパースする。失敗時は None。"""
    import csv as _csv
    import io as _io

    lines = [l for l in stdout.splitlines() if l.strip()]
    if not lines:
        return []
    try:
        rows = list(_csv.reader(_io.StringIO("\n".join(lines))))
    except Exception:
        return None
    if not rows:
        return []
    header = [c.strip().lower() for c in rows[0]]
    # ヘッダ行でなければ CSV 形式ではない
    if not any(h in ("#", "number", "no.", "no") for h in header):
        return None

    def _col(*names):
        for i, h in enumerate(header):
            if h in names:
                return i
        return None

    i_num = _col("#", "number", "no.", "no")
    i_type = _col("type")
    i_pre = _col("pre #", "pre number", "pre", "pre#")
    i_date = _col("date")
    i_user = _col("user")
    i_cleanup = _col("cleanup")
    i_desc = _col("description")
    i_userdata = _col("userdata")
    snapshots = []
    for r in rows[1:]:
        if i_num is None or i_num >= len(r):
            continue
        num = r[i_num].strip()
        if not num.isdigit():
            continue
        snapshots.append({
            "number": int(num),
            "type": r[i_type].strip() if i_type is not None and i_type < len(r) else "",
            "pre": r[i_pre].strip() if i_pre is not None and i_pre < len(r) else "",
            "date": r[i_date].strip() if i_date is not None and i_date < len(r) else "",
            "user": r[i_user].strip() if i_user is not None and i_user < len(r) else "",
            "cleanup": r[i_cleanup].strip() if i_cleanup is not None and i_cleanup < len(r) else "",
            "description": r[i_desc].strip() if i_desc is not None and i_desc < len(r) else "",
            "userdata": r[i_userdata].strip() if i_userdata is not None and i_userdata < len(r) else "",
        })
    return snapshots


def _parse_snapper_list_plain(stdout: str) -> list[dict]:
    """snapper list (表形式) の出力をパースするフォールバック。"""
    snapshots = []
    for line in stdout.splitlines():
        if "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|")]
        if not cols or not cols[0].isdigit():
            continue
        # 期待する列: # | Type | Pre # | Date | User | Cleanup | Description | Userdata
        snapshots.append({
            "number": int(cols[0]),
            "type": cols[1] if len(cols) > 1 else "",
            "pre": cols[2] if len(cols) > 2 else "",
            "date": cols[3] if len(cols) > 3 else "",
            "user": cols[4] if len(cols) > 4 else "",
            "cleanup": cols[5] if len(cols) > 5 else "",
            "description": cols[6] if len(cols) > 6 else "",
            "userdata": cols[7] if len(cols) > 7 else "",
        })
    return snapshots


async def _snapper_list_configs() -> list[dict]:
    """snapper list-configs をパースして設定一覧を返す。"""
    r = await run_cmd(_sudo("snapper --csvout list-configs 2>/dev/null"), timeout=10)
    configs: list[dict] = []
    if r["returncode"] == 0 and r["stdout"].strip():
        import csv as _csv
        import io as _io
        try:
            rows = list(_csv.reader(_io.StringIO(r["stdout"])))
            if rows:
                header = [c.strip().lower() for c in rows[0]]
                i_cfg = next((i for i, h in enumerate(header) if h == "config"), 0)
                i_sub = next((i for i, h in enumerate(header) if h == "subvolume"), 1)
                for row in rows[1:]:
                    if len(row) > i_cfg and row[i_cfg].strip():
                        configs.append({
                            "config": row[i_cfg].strip(),
                            "subvolume": row[i_sub].strip() if len(row) > i_sub else "",
                        })
                return configs
        except Exception:
            pass
    # フォールバック: 表形式
    r2 = await run_cmd(_sudo("snapper list-configs 2>/dev/null"), timeout=10)
    for line in r2["stdout"].splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|")]
        if cols[0].lower() == "config" or set(line) <= set("-+| "):
            continue
        if SNAPPER_CONFIG_RE.fullmatch(cols[0] or ""):
            configs.append({"config": cols[0], "subvolume": cols[1] if len(cols) > 1 else ""})
    return configs


@app.get("/api/snapper/status")
async def snapper_status():
    """snapper の導入状態と設定一覧を返す。"""
    which = await run_cmd("which snapper", timeout=5)
    installed = which["returncode"] == 0
    configs = await _snapper_list_configs() if installed else []
    return {"installed": installed, "configs": configs}


@app.get("/api/snapper/snapshots")
async def snapper_snapshots(config: str = "root"):
    """指定設定のスナップショット一覧を返す。"""
    cfg = _validate_snapper_config(config)
    which = await run_cmd("which snapper", timeout=5)
    if which["returncode"] != 0:
        raise HTTPException(status_code=500, detail="snapper がインストールされていません (sudo pacman -S snapper)")
    r = await run_cmd(_sudo(f"snapper -c {shlex.quote(cfg)} --csvout list 2>&1"), timeout=15)
    snapshots = _parse_snapper_list_csv(r["stdout"]) if r["stdout"] else None
    if snapshots is None:
        r2 = await run_cmd(_sudo(f"snapper -c {shlex.quote(cfg)} list 2>&1"), timeout=15)
        if r2["returncode"] != 0:
            raise HTTPException(status_code=500, detail=(r2["stderr"] or r2["stdout"]).strip() or "スナップショット一覧を取得できませんでした")
        snapshots = _parse_snapper_list_plain(r2["stdout"])
    snapshots.sort(key=lambda s: s["number"], reverse=True)
    return {"config": cfg, "snapshots": snapshots, "count": len(snapshots)}


@app.post("/api/snapper/create")
async def snapper_create(req: Request):
    """スナップショットを作成する。"""
    data = await req.json()
    cfg = _validate_snapper_config(data.get("config", "root"))
    description = (data.get("description") or "").strip() or f"cachy-UI manual {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    cleanup = (data.get("cleanup") or "").strip()
    if cleanup and cleanup not in SNAPPER_CLEANUP_VALUES:
        raise HTTPException(status_code=400, detail="invalid cleanup value")
    cmd = _sudo(f"snapper -c {shlex.quote(cfg)} create --description {shlex.quote(description)}")
    if cleanup:
        cmd += f" --cleanup {shlex.quote(cleanup)}"
    cmd += " --print-number"
    r = await run_cmd(cmd, timeout=60)
    if r["returncode"] != 0:
        err = (r["stderr"] or r["stdout"]).strip()
        return {"success": False, "message": f"スナップショットの作成に失敗しました: {err}"}
    num = r["stdout"].strip().splitlines()
    num = num[-1].strip() if num else ""
    return {"success": True, "message": f"スナップショット #{num} を作成しました ({description})" if num else "スナップショットを作成しました"}


@app.post("/api/snapper/delete")
async def snapper_delete(req: Request):
    """スナップショットを削除する。"""
    data = await req.json()
    cfg = _validate_snapper_config(data.get("config", "root"))
    number = _validate_snapshot_number(data.get("number"))
    r = await run_cmd(_sudo(f"snapper -c {shlex.quote(cfg)} delete {number}"), timeout=60)
    if r["returncode"] != 0:
        err = (r["stderr"] or r["stdout"]).strip()
        return {"success": False, "message": f"スナップショット #{number} の削除に失敗しました: {err}"}
    return {"success": True, "message": f"スナップショット #{number} を削除しました"}


@app.post("/api/snapper/restore")
async def snapper_restore(req: Request):
    """スナップショットから復元する (Btrfs Assistant 方式が主、失敗時は snapper rollback にフォールバック)。"""
    data = await req.json()
    cfg = _validate_snapper_config(data.get("config", "root"))
    number = _validate_snapshot_number(data.get("number"))
    # Btrfs Assistant と同じ動作: top-level にマウントして rename + btrfs snapshot で置換する。
    # snapper rollback は ambit/既定サブボリューム未設定等で失敗する (`--ambit` エラー) ため先にこちらを試す。
    manual = await _snapper_assistant_restore(cfg, number)
    if manual is not None:
        return manual
    # 手動復元の前提が揃わない場合は従来の snapper rollback を試す
    r = await run_cmd(_sudo(f"snapper -c {shlex.quote(cfg)} rollback {number}"), timeout=180)
    if r["returncode"] != 0:
        err = (r["stderr"] or r["stdout"]).strip()
        return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: {err}"}
    out = (r["stdout"] or "").strip()
    msg = f"スナップショット #{number} に復元しました。変更を反映するには再起動してください。"
    if out:
        msg += f"\n{out}"
    return {"success": True, "message": msg}


def _parse_btrfs_subvolume_list(stdout: str) -> tuple[dict[int, str], dict[int, int]]:
    """`btrfs subvolume list [-p]` の出力をパースする。戻り値は (id->path, id->parent)。"""
    id_to_path: dict[int, str] = {}
    id_to_parent: dict[int, int] = {}
    for line in (stdout or "").splitlines():
        m = re.match(r"^ID\s+(\d+).*?parent\s+(\d+).*?path\s+(.+?)\s*$", line.strip())
        if not m:
            # -p 無し等の旧形式フォールバック: ID ... path ...
            m2 = re.match(r"^ID\s+(\d+).*?path\s+(.+?)\s*$", line.strip())
            if not m2:
                continue
            try:
                id_to_path[int(m2.group(1))] = m2.group(2).strip()
            except ValueError:
                continue
            continue
        try:
            sid, parent, path = int(m.group(1)), int(m.group(2)), m.group(3).strip()
        except ValueError:
            continue
        id_to_path[sid] = path
        id_to_parent[sid] = parent
    return id_to_path, id_to_parent


def _is_snapper_snapshot_path(path: str) -> bool:
    """Btrfs Assistant の isSnapper と同等: `.../<数字>/snapshot` で終わるか。"""
    return re.search(r"/[0-9]+/snapshot$", path or "") is not None


def _snapper_snapshot_prefix(path: str) -> str | None:
    """`@/.snapshots/45/snapshot` -> `@/.snapshots`。`.snapshots` 直下の場合は `.snapshots`。"""
    m = re.match(r"^(.*)/[0-9]+/snapshot$", path or "")
    if m:
        return m.group(1)
    if path == ".snapshots":
        return ""
    return None


async def _btrfs_rootid(path: str) -> int | None:
    """サブボリュームの ID を返す。`btrfs inspect-internal rootid` が無ければ `subvolume show` で代用。"""
    r = await run_cmd(_sudo(f"btrfs inspect-internal rootid {shlex.quote(path)} 2>/dev/null"), timeout=10)
    if r["returncode"] == 0:
        m = re.search(r"(\d+)", r["stdout"] or "")
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                pass
    r2 = await run_cmd(_sudo(f"btrfs subvolume show {shlex.quote(path)} 2>/dev/null"), timeout=10)
    if r2["returncode"] == 0:
        for key in ("Subvolume ID:", "subvol id:", "ID:"):
            m = re.search(rf"{re.escape(key)}\s*(\d+)", r2["stdout"] or "")
            if m:
                try:
                    return int(m.group(1))
                except ValueError:
                    pass
    return None


async def _snapper_get_subvolume(cfg: str) -> str:
    """snapper 設定の SUBVOLUME を返す (既定は /)。"""
    r = await run_cmd(_sudo(f"snapper -c {shlex.quote(cfg)} get-config 2>/dev/null"), timeout=10)
    for line in (r["stdout"] or "").splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) >= 2 and cols[0] == "SUBVOLUME" and cols[1]:
            return cols[1]
    # list-configs から補完
    for c in await _snapper_list_configs():
        if c.get("config") == cfg and c.get("subvolume"):
            return c["subvolume"]
    return "/"


async def _snapper_assistant_restore(cfg: str, number: int) -> dict | None:
    """Btrfs Assistant の restoreSubvol と同じ手順で復元する。

    成功・失敗確定時は結果 dict を返し、前提が揃わず snapper rollback に
    譲るべき場合のみ None を返す。
    """
    subvol_abs = await _snapper_get_subvolume(cfg) or "/"
    # スナップショット実体の候補 (標準レイアウト: <SUBVOLUME>/.snapshots/<N>/snapshot)
    candidates = [os.path.join(subvol_abs, ".snapshots", str(number), "snapshot")]
    if subvol_abs != "/":
        candidates.append(f"/.snapshots/{number}/snapshot")
    snap_abs = None
    for c in candidates:
        t = await run_cmd(_sudo(f"test -d {shlex.quote(c)}"), timeout=5)
        if t["returncode"] == 0:
            snap_abs = c
            break
    if snap_abs is None:
        return None
    sv = await run_cmd(_sudo(f"btrfs subvolume show {shlex.quote(snap_abs)} 2>/dev/null"), timeout=10)
    if sv["returncode"] != 0:
        return None

    # ファイルシステム UUID とデバイスを特定
    uuid = ""
    for target in (subvol_abs, snap_abs, "/"):
        u = await run_cmd(f"findmnt -no UUID -T {shlex.quote(target)} 2>/dev/null", timeout=5)
        if u["returncode"] == 0 and u["stdout"].strip():
            uuid = u["stdout"].strip().splitlines()[0].strip()
            break
    if not uuid:
        return None
    device = ""
    for target in (subvol_abs, snap_abs, "/"):
        d = await run_cmd(f"findmnt -no SOURCE -T {shlex.quote(target)} 2>/dev/null", timeout=5)
        if d["returncode"] == 0 and d["stdout"].strip():
            device = d["stdout"].strip().splitlines()[0].strip()
            break
    if not device:
        return None
    device = re.sub(r"\[.*\]$", "", device).strip()
    if not device:
        return None

    # top-level (subvolid=5) のマウント点を探す。無ければ一時マウントする。
    # 注意: / 等の通常マウント点 (@) を top-level と誤認するとパス計算が崩れるため、
    # subvolid=5 でマウントされている場合のみ再利用する。
    tmp_root = ""
    mounted_by_us = False
    tmp_dir = ""
    fm = await run_cmd("findmnt -rn -t btrfs -o UUID,TARGET,OPTIONS 2>/dev/null", timeout=5)
    if fm["returncode"] == 0:
        for line in fm["stdout"].splitlines():
            line = line.strip()
            if not line:
                continue
            # UUID に空白は含まれないため先頭2カラムで判定し、残りをオプションとみなす
            parts = line.split(None, 2)
            if len(parts) >= 2 and parts[0] == uuid:
                cand, opts = parts[1], (parts[2] if len(parts) > 2 else "")
                if "subvolid=5" in opts:
                    tmp_root = cand
                    break
    if not tmp_root:
        fm5 = await run_cmd("findmnt -rn -O subvolid=5 -o UUID,TARGET 2>/dev/null", timeout=5)
        if fm5["returncode"] == 0:
            for line in fm5["stdout"].splitlines():
                parts = line.strip().split()
                if len(parts) >= 2 and parts[0] == uuid:
                    tmp_root = parts[1].strip()
                    break
    if not tmp_root:
        try:
            tmp_dir = tempfile.mkdtemp(prefix="cachyui-btrfs-root-")
        except Exception as e:
            return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: 一時ディレクトリを作成できません: {e}"}
        m = await run_cmd(_sudo(f"mount -t btrfs -o subvolid=5 {shlex.quote(device)} {shlex.quote(tmp_dir)}"), timeout=30)
        if m["returncode"] != 0:
            err = ((m["stderr"] or "") + (m["stdout"] or "")).strip()
            try:
                os.rmdir(tmp_dir)
            except OSError:
                pass
            # マウントできなければ snapper rollback に譲らずエラーにする (ambit エラーの代替手段がないため)
            return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: btrfs の top-level をマウントできません: {err}"}
        tmp_root = tmp_dir
        mounted_by_us = True

    async def _cleanup():
        if mounted_by_us and tmp_root:
            await run_cmd(_sudo(f"umount {shlex.quote(tmp_root)}"), timeout=30)
            try:
                os.rmdir(tmp_root)
            except OSError:
                pass

    try:
        target_id = await _btrfs_rootid(subvol_abs)
        source_id = await _btrfs_rootid(snap_abs)
        if not target_id or not source_id:
            await _cleanup()
            return None
        if target_id == 5:
            await _cleanup()
            return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: パーティション直下には復元できません"}

        lst = await run_cmd(_sudo(f"btrfs subvolume list -p {shlex.quote(tmp_root)} 2>/dev/null"), timeout=30)
        if lst["returncode"] != 0:
            lst = await run_cmd(_sudo(f"btrfs subvolume list {shlex.quote(tmp_root)} 2>/dev/null"), timeout=30)
        if lst["returncode"] != 0:
            await _cleanup()
            return None
        id_to_path, id_to_parent = _parse_btrfs_subvolume_list(lst["stdout"])
        target_name = id_to_path.get(target_id, "")
        source_name = id_to_path.get(source_id, "")
        if not target_name:
            # findmnt の subvol= オプションから補完 (例: rootflags=subvol=@)
            fo = await run_cmd(f"findmnt -no OPTIONS -T {shlex.quote(subvol_abs)} 2>/dev/null", timeout=5)
            m = re.search(r"subvol=([^, ]+)", fo["stdout"] or "")
            if m:
                target_name = m.group(1).strip().lstrip("/")
        if not target_name or not source_name:
            await _cleanup()
            return None
        if not _is_snapper_snapshot_path(source_name):
            await _cleanup()
            return None

        # 復元対象の子サブボリューム (Btrfs::children と同じく直接の子のみ)
        children = [p for sid, p in id_to_path.items() if id_to_parent.get(sid) == target_id]

        # バックアップ名 (Btrfs Assistant と同じ形式: <target>_backup_<UTC時刻>)
        stamp = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        backup_name = f"{target_name}_backup_{stamp}"
        src_top = os.path.join(tmp_root, target_name)
        dst_top = os.path.join(tmp_root, backup_name)
        # ネスト対策: 親ディレクトリが無ければ作成 (例: @home 等の直下配置)
        parent_dir = os.path.dirname(dst_top)
        await run_cmd(_sudo(f"mkdir -p {shlex.quote(parent_dir)}"), timeout=10)

        mv1 = await run_cmd(_sudo(f"mv -T {shlex.quote(src_top)} {shlex.quote(dst_top)}"), timeout=120)
        if mv1["returncode"] != 0:
            err = ((mv1["stderr"] or "") + (mv1["stdout"] or "")).strip()
            await _cleanup()
            return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: 現行ボリュームの退避に失敗しました: {err}"}

        # source が target 配下の場合は退避後のパスに読み替える
        if source_name == target_name or source_name.startswith(target_name.rstrip("/") + "/"):
            new_source = backup_name + source_name[len(target_name):]
        else:
            new_source = source_name
        snap_src = os.path.join(tmp_root, new_source)
        snap_dst = os.path.join(tmp_root, target_name)
        sn = await run_cmd(_sudo(f"btrfs subvolume snapshot {shlex.quote(snap_src)} {shlex.quote(snap_dst)}"), timeout=180)
        if sn["returncode"] != 0:
            err = ((sn["stderr"] or "") + (sn["stdout"] or "")).strip()
            # 元に戻す
            await run_cmd(_sudo(f"mv -T {shlex.quote(dst_top)} {shlex.quote(src_top)}"), timeout=120)
            await _cleanup()
            return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: スナップショットのコピーに失敗しました: {err}"}

        # 子サブボリュームを新ボリュームへ移行 (.snapshots 等)
        child_warnings: list[str] = []
        prefix = target_name.rstrip("/") + "/"
        for child in children:
            if not child.startswith(prefix):
                continue
            rel = child[len(prefix):]
            old_path = os.path.join(tmp_root, backup_name, rel)
            new_path = os.path.join(tmp_root, child)
            ex = await run_cmd(_sudo(f"test -e {shlex.quote(old_path)}"), timeout=5)
            if ex["returncode"] != 0:
                continue
            # 新側にある空スタブを除去 (サブボリュームなら delete、ただの空ディレクトリなら rmdir)
            is_sub = await run_cmd(_sudo(f"btrfs subvolume show {shlex.quote(new_path)} 2>/dev/null"), timeout=10)
            if is_sub["returncode"] == 0:
                await run_cmd(_sudo(f"btrfs subvolume delete {shlex.quote(new_path)}"), timeout=60)
            else:
                await run_cmd(_sudo(f"rmdir {shlex.quote(new_path)} 2>/dev/null"), timeout=10)
            mv = await run_cmd(_sudo(f"mv -T {shlex.quote(old_path)} {shlex.quote(new_path)}"), timeout=120)
            if mv["returncode"] != 0:
                err = ((mv["stderr"] or "") + (mv["stdout"] or "")).strip()
                child_warnings.append(f"{rel}: {err}")

        fstab_warn = ""
        fb = await run_cmd("grep -E 'subvolid=' /etc/fstab 2>/dev/null", timeout=5)
        if fb["returncode"] == 0 and (fb["stdout"] or "").strip():
            fstab_warn = "\n注意: /etc/fstab で subvolid 指定のマウントが検出されました。subvol=@ 等のパス指定に切替えていないと次回起動時に復元が反映されない場合があります。"

        await _cleanup()
        msg = (f"スナップショット #{number} を復元しました (Btrfs Assistant 方式)。\n"
               f"元のボリュームは {backup_name} として保存されています。\n"
               f"変更を反映するには直ちに再起動してください。{fstab_warn}")
        if child_warnings:
            msg += "\n警告: 一部のネストされたサブボリュームの移行に失敗しました (手動で移行してください):\n" + "\n".join(child_warnings)
        return {"success": True, "message": msg}
    except Exception as e:
        try:
            await _cleanup()
        except Exception:
            pass
        return {"success": False, "message": f"スナップショット #{number} への復元に失敗しました: {e}"}


# ============================================================
# 8.6 アプリ導入 (cachyos-scripts 方式)
# ============================================================
# 参考: https://github.com/hirogura/cachyos-scripts.git
#   3-soft.sh (日本語入力/mozc・Chrome・Thunderbird・LibreOffice・VLC)
#   4-desktopicon.sh (デスクトップショートカット)
MOZC_SETUP_URL = "https://raw.githubusercontent.com/hirogura/scripts/main/cachyos-mozcjp.sh"

APP_INSTALL_KEYS = ("japanese", "chrome", "thunderbird", "libreoffice", "vlc", "ssh", "rdp")

APP_LABELS = {
    "japanese": "日本語入力",
    "chrome": "Google Chrome",
    "thunderbird": "Thunderbird",
    "libreoffice": "LibreOffice",
    "vlc": "VLC",
    "ssh": "SSH",
    "rdp": "リモートデスクトップ",
}


def _as_user_cmd(username: str, cmd: str) -> str:
    """指定ユーザーとしてコマンドを実行する (paru は root 実行不可のため)。"""
    base = f"sudo -u {shlex.quote(username)} {cmd}"
    if IS_ROOT:
        return base
    return f"sudo {base}"


async def _check_app_status() -> dict:
    """各アプリの導入状態を返す。"""
    status: dict = {}

    q_mozc = await run_cmd("pacman -Q fcitx5-mozc 2>/dev/null", timeout=10)
    status["japanese"] = {"installed": q_mozc["returncode"] == 0,
                          "detail": q_mozc["stdout"].strip().splitlines()[0] if q_mozc["returncode"] == 0 and q_mozc["stdout"].strip() else ""}

    q_chrome = await run_cmd("pacman -Q google-chrome 2>/dev/null", timeout=10)
    w_chrome = await run_cmd("which google-chrome 2>/dev/null", timeout=5)
    status["chrome"] = {"installed": q_chrome["returncode"] == 0 or w_chrome["returncode"] == 0,
                        "detail": q_chrome["stdout"].strip().splitlines()[0] if q_chrome["returncode"] == 0 and q_chrome["stdout"].strip() else ""}

    q_tb = await run_cmd("pacman -Q thunderbird 2>/dev/null", timeout=10)
    status["thunderbird"] = {"installed": q_tb["returncode"] == 0,
                             "detail": q_tb["stdout"].strip().splitlines()[0] if q_tb["returncode"] == 0 and q_tb["stdout"].strip() else ""}

    q_lo = await run_cmd("pacman -Q libreoffice-fresh-ja 2>/dev/null", timeout=10)
    status["libreoffice"] = {"installed": q_lo["returncode"] == 0,
                             "detail": q_lo["stdout"].strip().splitlines()[0] if q_lo["returncode"] == 0 and q_lo["stdout"].strip() else ""}

    q_vlc = await run_cmd("pacman -Q vlc 2>/dev/null", timeout=10)
    status["vlc"] = {"installed": q_vlc["returncode"] == 0,
                     "detail": q_vlc["stdout"].strip().splitlines()[0] if q_vlc["returncode"] == 0 and q_vlc["stdout"].strip() else ""}

    en_ssh = await run_cmd("systemctl is-enabled sshd 2>/dev/null", timeout=5)
    ac_ssh = await run_cmd("systemctl is-active sshd 2>/dev/null", timeout=5)
    ssh_on = en_ssh["stdout"].strip() == "enabled" or ac_ssh["stdout"].strip() == "active"
    status["ssh"] = {"installed": ssh_on,
                     "detail": f"{en_ssh['stdout'].strip()}/{ac_ssh['stdout'].strip()}" if (en_ssh["stdout"] or ac_ssh["stdout"]) else ""}

    q_krdp = await run_cmd("pacman -Q krdp 2>/dev/null", timeout=10)
    status["rdp"] = {"installed": q_krdp["returncode"] == 0,
                     "detail": q_krdp["stdout"].strip().splitlines()[0] if q_krdp["returncode"] == 0 and q_krdp["stdout"].strip() else ""}
    return status


async def _install_single_app(key: str) -> dict:
    """アプリを1件インストールする。戻り値: {success, output}。"""
    logs: list[str] = []

    async def _step(cmd: str, timeout: int = 900, extra_env: dict | None = None) -> bool:
        r = await run_cmd(cmd, timeout=timeout, extra_env=extra_env)
        if r["stdout"].strip():
            logs.append(r["stdout"].strip()[-2000:])
        if r["returncode"] != 0:
            err = (r["stderr"] or r["stdout"]).strip()[-2000:]
            logs.append(f"エラー: {err}")
            return False
        return True

    if key == "japanese":
        # 3-soft.sh と同じ方式: mozc セットアップスクリプトを実行する。
        # スクリプトは SUDO_USER のホームに fcitx5/mozc 設定を書き込むため、
        # プライマリユーザーを明示して実行する。
        username, home, _shell = get_primary_user()
        ok = await _step(
            _sudo(f"bash -c {shlex.quote(f'curl -fsSL {MOZC_SETUP_URL} | bash')}"),
            timeout=600,
            extra_env={"SUDO_USER": username, "HOME": home if IS_ROOT else os.environ.get("HOME", home)},
        )
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "chrome":
        username, home, _shell = get_primary_user()
        if not await _step(_sudo("pacman -S --noconfirm --needed paru"), timeout=600):
            return {"success": False, "output": "\n".join(logs)[-3000:]}
        ok = await _step(
            _as_user_cmd(username, "paru -S --noconfirm --needed google-chrome"),
            timeout=1800,
            extra_env={"HOME": home},
        )
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "thunderbird":
        ok = await _step(_sudo("pacman -S --noconfirm --needed thunderbird thunderbird-i18n-ja"), timeout=900)
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "libreoffice":
        ok = await _step(_sudo("pacman -S --noconfirm --needed libreoffice-fresh-ja"), timeout=900)
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "vlc":
        ok = await _step(_sudo("pacman -S --noconfirm --needed vlc"), timeout=900)
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "ssh":
        if not await _step(_sudo("systemctl enable --now sshd"), timeout=60):
            return {"success": False, "output": "\n".join(logs)[-3000:]}
        # ufw が無い環境ではスキップ扱いにする
        w_ufw = await run_cmd("which ufw", timeout=5)
        if w_ufw["returncode"] != 0:
            logs.append("ufw がインストールされていないためファイアウォール設定をスキップしました (sshd 自体は有効化済み)")
            return {"success": True, "output": "\n".join(logs)[-3000:]}
        ok = await _step(_sudo("ufw allow ssh"), timeout=60)
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    elif key == "rdp":
        ok = await _step(_sudo("pacman -S --noconfirm --needed krdp"), timeout=900)
        return {"success": ok, "output": "\n".join(logs)[-3000:]}
    return {"success": False, "output": "不明なアプリ指定です"}


@app.get("/api/apps/status")
async def apps_status():
    """各アプリの導入状態を返す。"""
    return {"apps": await _check_app_status()}


@app.post("/api/apps/install")
async def apps_install(req: Request):
    """チェックされたアプリをインストールする。"""
    data = await req.json()
    keys = data.get("apps") or []
    if not isinstance(keys, list) or not keys:
        raise HTTPException(status_code=400, detail="apps are required")
    clean = [k for k in keys if k in APP_INSTALL_KEYS]
    if not clean:
        raise HTTPException(status_code=400, detail="invalid apps")
    # 重複除去 (順序維持)
    seen: list[str] = []
    for k in clean:
        if k not in seen:
            seen.append(k)
    results: dict = {}
    for k in seen:
        results[k] = await _install_single_app(k)
    success = all(v["success"] for v in results.values())
    summary = ", ".join(f"{APP_LABELS[k]}: {'OK' if v['success'] else 'NG'}" for k, v in results.items())
    return {"success": success, "results": results, "message": summary}


# --- デスクトップショートカット (4-desktopicon.sh 方式) ---
SHORTCUT_DEFS: dict[str, dict] = {
    "google-chrome": {"label": "Google Chrome", "candidates": ["google-chrome.desktop"]},
    "thunderbird": {"label": "Thunderbird", "candidates": ["thunderbird.desktop", "org.mozilla.Thunderbird.desktop"]},
    "libreoffice-calc": {"label": "LibreOffice Calc", "candidates": ["libreoffice-calc.desktop", "org.libreoffice.calc.desktop"]},
    "libreoffice-writer": {"label": "LibreOffice Writer", "candidates": ["libreoffice-writer.desktop", "org.libreoffice.writer.desktop"]},
    "libreoffice-impress": {"label": "LibreOffice Impress", "candidates": ["libreoffice-impress.desktop", "org.libreoffice.impress.desktop"]},
    "vlc": {"label": "VLC", "candidates": ["vlc.desktop"]},
    "dolphin": {"label": "Dolphin", "candidates": ["org.kde.dolphin.desktop"]},
    "systemsettings": {"label": "KDEシステム設定", "candidates": ["systemsettings.desktop", "kdesystemsettings.desktop", "org.kde.systemsettings.desktop"]},
    "konsole": {"label": "Konsole", "candidates": ["org.kde.konsole.desktop", "konsole.desktop"]},
    "kwrite": {"label": "KWrite", "candidates": ["org.kde.kwrite.desktop", "kwrite.desktop"]},
    "systemmonitor": {"label": "システムモニタ", "candidates": ["org.kde.plasma-systemmonitor.desktop", "plasma-systemmonitor.desktop", "org.kde.ksysguard.desktop"]},
    "update": {"label": "アップデート", "special": "update"},
}

SHORTCUT_APPDIRS = [
    "/usr/local/share/applications",
    "/usr/share/applications",
    ".local/share/applications",  # ホーム相対
    ".local/share/flatpak/exports/share/applications",
    "/var/lib/flatpak/exports/share/applications",
    "/var/lib/snapd/desktop/applications",
]

PACMAN_UPDATE_SCRIPT = """#!/bin/bash
# システム全体を更新する (sudo pacman -Syu --noconfirm)
echo "システム更新を開始します..."
sudo pacman -Syu --noconfirm
echo ""
read -r -p "更新が完了しました。Enter キーで閉じます..."
"""


def _get_desktop_dir(username: str, home: str) -> str:
    """プライマリユーザーのデスクトップディレクトリを取得する (4-desktopicon.sh と同じ方式)。"""
    dest = ""
    r = subprocess.run(
        ["sudo", "-u", username, "xdg-user-dir", "DESKTOP"],
        capture_output=True, text=True, timeout=10,
    ) if IS_ROOT else subprocess.run(
        ["xdg-user-dir", "DESKTOP"],
        capture_output=True, text=True, timeout=10,
    )
    if r.returncode == 0 and r.stdout.strip():
        dest = r.stdout.strip()
    if not dest:
        cand_jp = os.path.join(home, "デスクトップ")
        dest = cand_jp if os.path.isdir(cand_jp) else os.path.join(home, "Desktop")
    os.makedirs(dest, exist_ok=True)
    try:
        pw = pwd.getpwnam(username)
        os.chown(dest, pw.pw_uid, pw.pw_gid)
    except Exception:
        pass
    return dest


def _find_desktop_source(candidates: list[str], home: str) -> str | None:
    """XDG 標準ディレクトリから .desktop ファイルを探す。"""
    for d in SHORTCUT_APPDIRS:
        base = os.path.join(home, d) if d.startswith(".") else d
        if not os.path.isdir(base):
            continue
        for f in candidates:
            full = os.path.join(base, f)
            if os.path.isfile(full):
                return full
    return None


def _chown_user(path: str, username: str) -> None:
    try:
        pw = pwd.getpwnam(username)
        os.chown(path, pw.pw_uid, pw.pw_gid)
    except Exception:
        pass


def _create_update_shortcut(desktop_dir: str, home: str, username: str) -> str:
    """「アップデート」ショートカットを作成する (4-desktopicon.sh 第5節と同等)。"""
    bin_dir = os.path.join(home, ".local", "bin")
    os.makedirs(bin_dir, exist_ok=True)
    script_path = os.path.join(bin_dir, "pacman-update.sh")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(PACMAN_UPDATE_SCRIPT)
    os.chmod(script_path, 0o755)
    _chown_user(script_path, username)
    desktop_file = os.path.join(desktop_dir, "update.desktop")
    with open(desktop_file, "w", encoding="utf-8") as f:
        f.write(
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Version=1.0\n"
            "Name=アップデート\n"
            "Name[en]=Update\n"
            "GenericName=システム更新\n"
            "Comment=システム全体を更新する (pacman -Syu)\n"
            f"Exec={script_path}\n"
            "Icon=system-software-update\n"
            "Terminal=true\n"
            "Categories=System;Utility;\n"
        )
    os.chmod(desktop_file, 0o755)
    _chown_user(desktop_file, username)
    return desktop_file


@app.get("/api/apps/shortcuts")
async def apps_shortcuts_list():
    """作成可能なショートカット一覧 (ソース有無・作成済み) を返す。"""
    username, home, _shell = get_primary_user()
    try:
        desktop_dir = await asyncio.to_thread(_get_desktop_dir, username, home)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"デスクトップディレクトリを取得できませんでした: {e}")
    items = []
    for key, spec in SHORTCUT_DEFS.items():
        if spec.get("special") == "update":
            src = True
            dest = os.path.join(desktop_dir, "update.desktop")
        else:
            src_path = await asyncio.to_thread(_find_desktop_source, spec["candidates"], home)
            src = bool(src_path)
            dest = os.path.join(desktop_dir, os.path.basename(src_path)) if src_path else ""
        items.append({
            "key": key,
            "label": spec["label"],
            "source_found": src,
            "created": bool(dest) and os.path.isfile(dest),
            "dest": dest,
        })
    return {"desktop_dir": desktop_dir, "shortcuts": items}


@app.post("/api/apps/shortcuts")
async def apps_shortcuts_create(req: Request):
    """チェックされたデスクトップショートカットを作成する。"""
    data = await req.json()
    keys = data.get("shortcuts") or []
    if not isinstance(keys, list) or not keys:
        raise HTTPException(status_code=400, detail="shortcuts are required")
    clean = [k for k in keys if k in SHORTCUT_DEFS]
    if not clean:
        raise HTTPException(status_code=400, detail="invalid shortcuts")
    username, home, _shell = get_primary_user()
    try:
        desktop_dir = await asyncio.to_thread(_get_desktop_dir, username, home)
    except Exception as e:
        return {"success": False, "message": f"デスクトップディレクトリを取得できませんでした: {e}"}
    results: dict = {}
    for key in dict.fromkeys(clean):
        spec = SHORTCUT_DEFS[key]
        try:
            if spec.get("special") == "update":
                dest = await asyncio.to_thread(_create_update_shortcut, desktop_dir, home, username)
                results[key] = {"success": True, "message": dest}
                continue
            src = await asyncio.to_thread(_find_desktop_source, spec["candidates"], home)
            if not src:
                results[key] = {"success": False, "message": ".desktop ファイルが見つかりません (アプリ未インストールの可能性)"}
                continue
            dest = os.path.join(desktop_dir, os.path.basename(src))

            def _copy() -> None:
                import shutil as _shutil
                _shutil.copyfile(src, dest)
                os.chmod(dest, 0o755)
                _chown_user(dest, username)

            await asyncio.to_thread(_copy)
            results[key] = {"success": True, "message": dest}
        except Exception as e:
            results[key] = {"success": False, "message": str(e)}
    success = all(v["success"] for v in results.values())
    summary = ", ".join(f"{SHORTCUT_DEFS[k]['label']}: {'OK' if v['success'] else 'NG'}" for k, v in results.items())
    return {"success": success, "results": results, "message": summary}


# 9. cachy-UI Fleet Management (Tailnet-wide bulk management)
# ============================================================
FLEET_PINS_FILE = Path(__file__).parent / "cachyui_fleet_pins.json"
CACHYUI_SERVE_PORT = 3355
_SSL_UNVERIFIED = ssl._create_unverified_context()
_FQDN_RE = re.compile(
    r"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$"
)
_TS_IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _load_fleet_pins() -> list[dict]:
    """Load pinned cachy-UI hosts from cachyui_fleet_pins.json."""
    try:
        with open(FLEET_PINS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [p for p in data if isinstance(p, dict) and p.get("key")]
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _save_fleet_pins(pins: list[dict]) -> None:
    tmp = FLEET_PINS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(pins, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(FLEET_PINS_FILE)


def _fleet_pin_key(fqdn: str, ips: list[str]) -> str | None:
    """Stable key for a node: FQDN when available, otherwise Tailscale IP."""
    fqdn = (fqdn or "").strip().rstrip(".").lower()
    if fqdn:
        return fqdn
    for ip in ips or []:
        if _TS_IP_RE.match(str(ip)):
            return str(ip)
    return None


def _fetch_remote_system_info_sync(candidates: list[tuple[str, ssl.SSLContext | None]],
                                   timeout: float = 3.0) -> dict | None:
    """Try candidate URLs in order; return parsed /api/system/info JSON of first success."""
    for url, ctx in candidates:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cachyui-fleet"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                if resp.status != 200:
                    continue
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except Exception:
            continue
    return None


async def _fetch_remote_system_info(fqdn: str, ips: list[str] | None = None,
                                    port: int = CACHYUI_SERVE_PORT) -> dict | None:
    candidates = []
    if fqdn:
        # LE cert issued for <host>.<tailnet>.ts.net is publicly trusted
        candidates.append((f"https://{fqdn}:{port}/api/system/info", None))
    for ip in (ips or []):
        if not _TS_IP_RE.match(str(ip)):
            continue
        # Fallback: direct Tailscale IP (cert is issued for the FQDN -> skip verify)
        candidates.append((f"https://{ip}:{port}/api/system/info", _SSL_UNVERIFIED))
    if not candidates:
        return None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _fetch_remote_system_info_sync, candidates)


def _extract_fleet_info(info: dict | None) -> dict | None:
    """Pick the fields shown on the bulk-management page from /api/system/info."""
    if not isinstance(info, dict):
        return None
    cpu = info.get("cpu") or {}
    mem = info.get("memory") or {}
    disk = info.get("disk") or {}
    return {
        "cpu_percent": cpu.get("percent"),
        "cpu_temp": cpu.get("temp"),
        "mem_percent": mem.get("percent"),
        "mem_used": mem.get("used"),
        "mem_total": mem.get("total"),
        "disk_percent": disk.get("percent"),
        "disk_used": disk.get("used"),
        "disk_total": disk.get("total"),
        "os": info.get("os"),
        "uptime_seconds": info.get("uptime_seconds"),
        "reported_hostname": info.get("hostname"),
    }


def _fleet_node_from_ts_entry(entry: dict) -> dict | None:
    """Convert a tailscale status Self/Peer entry into a fleet node dict."""
    if not isinstance(entry, dict):
        return None
    dns = (entry.get("DNSName") or "").strip().rstrip(".")
    ips = [str(i) for i in (entry.get("TailscaleIPs") or [])]
    short = (entry.get("HostName") or "").strip() or (dns.split(".")[0] if dns else "")
    key = _fleet_pin_key(dns, ips)
    if not key:
        return None
    online = entry.get("Online")
    if entry.get("Self") is True:
        online = True
    return {
        "key": key,
        "hostname": short or key,
        "fqdn": dns,
        "ips": ips,
        "online": bool(online),
    }


async def _probe_fleet_node(node: dict, semaphore: asyncio.Semaphore) -> dict:
    """Probe one node's cachy-UI and collect its system info."""
    display_host = node["fqdn"] or (node["ips"][0] if node["ips"] else node["key"])
    out = {
        **node,
        "port": CACHYUI_SERVE_PORT,
        "url": f"https://{display_host}:{CACHYUI_SERVE_PORT}/",
        "reachable": False,
        "info": None,
    }
    raw = None
    async with semaphore:
        try:
            raw = await _fetch_remote_system_info(node.get("fqdn", ""), node.get("ips"))
        except Exception:
            raw = None
    if raw is not None:
        out["reachable"] = True
        out["info"] = _extract_fleet_info(raw)
    return out


async def _probe_pinned_nodes(pins: list[dict]) -> list[dict]:
    sem = asyncio.Semaphore(8)

    async def probe(pin: dict) -> dict:
        node = {
            "key": pin["key"],
            "hostname": pin.get("hostname") or pin["key"].split(".")[0],
            "fqdn": pin.get("fqdn", ""),
            "ips": pin.get("ips") or [],
            "online": True,
            "is_self": False,
        }
        return await _probe_fleet_node(node, sem)

    return list(await asyncio.gather(*[probe(p) for p in pins]))


@app.get("/api/fleet/detect")
async def fleet_detect():
    """Detect cachy-UI instances running in the Tailnet.

    Lists all online peers (plus this host), probes their cachy-UI
    (https://<node>:3355) and collects live stats from reachable ones.
    """
    ts = await run_cmd("tailscale status --json", timeout=10)
    if ts["returncode"] != 0:
        return {"success": False,
                "error": f"tailscale status の取得に失敗しました: {ts['stderr'].strip() or 'Tailscaleが利用できません'}"}
    try:
        data = json.loads(ts["stdout"])
    except json.JSONDecodeError:
        return {"success": False, "error": "tailscale status の解析に失敗しました"}

    nodes = []
    self_node = _fleet_node_from_ts_entry(data.get("Self") or {})
    if self_node:
        self_node["is_self"] = True
        nodes.append(self_node)
    for peer in (data.get("Peer") or {}).values():
        n = _fleet_node_from_ts_entry(peer)
        if n and n["online"]:
            nodes.append(n)

    pinned_keys = {p["key"] for p in _load_fleet_pins()}
    for n in nodes:
        n["pinned"] = n["key"] in pinned_keys

    sem = asyncio.Semaphore(8)
    results = list(await asyncio.gather(*[_probe_fleet_node(n, sem) for n in nodes]))
    results.sort(key=lambda r: (not r["reachable"], r["hostname"].lower()))
    running = sum(1 for r in results if r["reachable"])
    return {"success": True, "nodes": results, "count": running}


@app.get("/api/fleet/pins")
async def fleet_pins_list():
    """Return pinned cachy-UI hosts with live stats."""
    pins = _load_fleet_pins()
    results = await _probe_pinned_nodes(pins)
    order = {p["key"]: i for i, p in enumerate(pins)}
    results.sort(key=lambda r: order.get(r["key"], len(order)))
    return {"pins": results}


@app.post("/api/fleet/pin")
async def fleet_pins_add(req: Request):
    """Pin a detected cachy-UI host (persisted in cachyui_fleet_pins.json)."""
    data = await req.json()
    fqdn = (data.get("fqdn") or "").strip().rstrip(".").lower()
    ips = [str(i) for i in (data.get("ips") or [])]
    key = _fleet_pin_key(fqdn, ips)
    if not key or (not fqdn and not any(_TS_IP_RE.match(i) for i in ips)):
        raise HTTPException(status_code=400, detail="fqdn or tailscale IP is required")

    hostname = (data.get("hostname") or "").strip() or key.split(".")[0]
    pins = _load_fleet_pins()
    if any(p["key"] == key for p in pins):
        return {"success": True, "message": "既にピン留めされています"}
    pins.append({"key": key, "fqdn": fqdn, "hostname": hostname,
                 "ips": [i for i in ips if _TS_IP_RE.match(i)]})
    _save_fleet_pins(pins)
    return {"success": True, "message": f"{hostname} をピン留めしました"}


@app.post("/api/fleet/unpin")
async def fleet_pins_remove(req: Request):
    """Unpin a cachy-UI host."""
    data = await req.json()
    key = (data.get("key") or "").strip().rstrip(".").lower()
    if not key:
        raise HTTPException(status_code=400, detail="key is required")
    pins = _load_fleet_pins()
    remaining = [p for p in pins if p["key"] != key]
    if len(remaining) == len(pins):
        return {"success": True, "message": "ピン留めされていません"}
    _save_fleet_pins(remaining)
    return {"success": True, "message": "ピン留めを解除しました"}


# ============================================================
# Main HTML page
# ============================================================
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=3355,
        log_level="info",
    )
