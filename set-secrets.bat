@echo off
cd /d %~dp0
npx wrangler secret put APIFY_TOKEN
npx wrangler secret put ACCESS_TOKEN
