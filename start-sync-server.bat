@echo off
title Logseq Translator Local Sync Server
echo =======================================================
echo   KHOI DONG LOGSEQ TRANSLATOR LOCAL SYNC SERVER
echo =======================================================
echo.
echo Dang khoi dong may chu dong bo truc tiep o dia...
node "%~dp0scripts\sync-server.mjs"
pause
