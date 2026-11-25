#!/usr/bin/env python3
"""ヘッドレスブラウザの共通設定。

ボット検出回避と日本語表示のため、ページを開く前に
BrowserContext へ user_agent / locale を設定する。
Playwright の page.goto() には user_agent / locale オプションが無いため、
設定は new_context() 側で行い、goto() は URL だけを受け取る。
"""

import sys

from playwright.sync_api import sync_playwright

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
LOCALE = "ja-JP"


def open_url(browser, url, wait_until="domcontentloaded", timeout=60000):
    """user_agent / locale を設定したコンテキストで URL を開く。"""
    context = browser.new_context(user_agent=USER_AGENT, locale=LOCALE)
    page = context.new_page()
    page.goto(url, wait_until=wait_until, timeout=timeout)
    return page


def main():
    if len(sys.argv) < 2:
        print("使い方: headless_browser.py <URL>")
        return 1
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        try:
            page = open_url(browser, sys.argv[1])
            print(page.title())
        finally:
            browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
