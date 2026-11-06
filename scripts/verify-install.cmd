@echo off
rem Windows launcher for scripts\verify-install: the check is dependency-free Node ESM, so run it with node.
node "%~dp0verify-install" %*
exit /b %errorlevel%
