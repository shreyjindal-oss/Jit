@echo off
cd /d %~dp0
if not exist node_modules call npm install
if not exist .dev.vars copy .dev.vars.example .dev.vars && echo Created .dev.vars - add your API keys, then re-run. && notepad .dev.vars && exit /b
npx wrangler dev
