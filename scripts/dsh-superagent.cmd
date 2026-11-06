@echo off
rem Windows launcher for scripts\dsh-superagent: the service manager is dependency-free Node ESM, so run it with node.
node "%~dp0dsh-superagent" %*
exit /b %errorlevel%
