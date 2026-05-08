@echo off
cd /d "%~dp0"
echo Fazendo git pull...
git pull origin main
echo.
echo Fazendo deploy no Supabase...
supabase functions deploy gerar-contrato
echo.
echo Pronto! Pressione qualquer tecla para fechar.
pause > nul
