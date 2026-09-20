@echo off
rem 源码方式的启动入口（需要 Node.js）。exe 用户不需要此文件。
rem 首次运行会自动 npm install && npm run build。参数原样透传给 node dist\index.js。
setlocal
chcp 65001 >nul
cd /d "%~dp0"
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
goto :eof
:fail
echo [cursor-zh] 构建失败，请检查 Node.js 是否已安装并可在 PATH 中找到。
pause
