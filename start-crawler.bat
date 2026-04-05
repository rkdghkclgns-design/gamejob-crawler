@echo off
%SystemRoot%\System32\chcp.com 65001 > nul
TITLE GameJob Crawler v5.0

cd /d "%~dp0"

REM 인수가 있으면 그대로 전달, 없으면 기본 태그 사용
if "%~1"=="" (
    node crawler.js
) else (
    node crawler.js %*
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] 크롤링 도중 오류가 발생했습니다.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [INFO] 5초 후 창이 자동으로 닫힙니다.
timeout /t 5
