@echo off
title JARVIS Island
color 0B
cls

REM Force working directory to this file's own folder - without this,
REM launching via a shortcut or "Run as administrator" can leave npm
REM looking in the wrong place (often System32) and failing to find
REM package.json even though it's sitting right here.
cd /d "%~dp0"

echo.
echo  ==========================================
echo   JARVIS ISLAND  --  Dynamic Island Overlay
echo  ==========================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo  Setting up your computer for the first time...
    echo  This installs one small thing Island needs to run - fully automatic, give it a minute.
    echo.
    winget --version >nul 2>&1
    if errorlevel 1 (
        echo  Couldn't auto-install - opening the download page for you instead.
        echo  Just click the big green "LTS" button, install it, then run this file again.
        start "" "https://nodejs.org"
        pause & exit
    )
    winget install OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    echo.
    echo  Done! Finishing setup...
    REM PATH doesn't refresh in this window until it restarts, so relaunch once
    start "" "%~f0"
    exit
)

if not exist "package.json" (
    echo  [ERROR] package.json not found in this folder:
    echo  %cd%
    echo.
    echo  Here's what's actually in this folder:
    echo  ------------------------------------------
    dir /b
    echo  ------------------------------------------
    echo.
    echo  Most common cause: Windows hides file extensions by default,
    echo  so a file saved as "package.json.txt" still LOOKS like
    echo  "package.json" in File Explorer, but isn't one.
    echo.
    echo  Fix: in File Explorer, go to View, tick "File name extensions",
    echo  then check if package.json above actually says package.json.txt.
    echo  If it does, rename it and remove the ".txt" part.
    pause & exit
)

if not exist "node_modules" (
    echo  Almost there - grabbing Island's files for the first time...
    echo  This only happens once, give it a minute.
    echo.
    call npm install
    echo.
)

echo  Opening Island...
echo.
call npm start

echo.
echo  ======= ISLAND STOPPED =======
echo  If you see an error above, screenshot it.
pause
