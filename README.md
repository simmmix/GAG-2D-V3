# Grow a Garden 2D – globální žebříčky

## Linux Mint / Debian
Vyžaduje Node.js 18+ a npm.
1. Rozbal ZIP.
2. Otevři Terminál ve složce `GAG2D_Global_Server`.
3. Spusť `npm install` a potom `npm start`.
4. Otevři http://localhost:3000.

V herním menu klikni na 🌍 TOP, vytvoř účet nebo se přihlas a zvol „Vybrat tuto zahradu do žebříčku“. Počítá se právě otevřený svět a pozemek. Další výběr nahradí předchozí. Žebříčky: TOP 3 mince, drahokamy a level.

## Upozornění
Toto je funkční první verze účtů a žebříčků. Protože původní hra ukládá ekonomiku v prohlížeči, server zatím přijímá hodnoty od klienta a nedokáže zabránit podvádění upraveným prohlížečem. Nepoužívej ji pro soutěže o skutečné ceny. Pro veřejné nasazení je potřeba serverově ověřovat všechny herní transakce a zapnout HTTPS.
Databáze `gag2d.sqlite` vznikne automaticky.
