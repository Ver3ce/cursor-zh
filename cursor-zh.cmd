@echo off
rem 源码方式的启动入口（需要 Node.js）。exe 用户不需要此文件。
rem 首次运行会自动 npm install && npm run build。参数原样透传给 node dist\index.js。
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem 告知程序：窗口归本脚本所有，出错时暂停而不是直接关窗
set CZ_LAUNCHER=cmd
where node >nul 2>nul || (
  echo [cursor-zh] 未找到 Node.js。请安装 Node.js 22+，或改用 Release 页面提供的 cursor-zh.exe。
  goto :fail
)
if not exist "dist\index.js" (
  echo [cursor-zh] 尚未构建，正在执行 npm install ^&^& npm run build ...
  call npm install --no-audit --no-fund || goto :fail
  call npm run build || goto :fail
)
if "%~1"=="" (
  node dist\index.js start
) else (
  node dist\index.js %*
)
if errorlevel 1 goto :fail
goto :eof
:fail
echo.
echo [cursor-zh] 运行出错（退出码 %errorlevel%）。日志文件: %~dp0logs\cursor-zh.log
pause
