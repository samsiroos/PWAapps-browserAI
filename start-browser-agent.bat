@echo off
cd /d "%~dp0"
start "Browser Agent" http://localhost:3210
npm start
