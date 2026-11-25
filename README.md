# Grow a Garden 2D – globální žebříčky

## Linux Mint / Debian
Vyžaduje Node.js 18+ a npm.
1. Rozbal ZIP.
2. Otevři Terminál ve složce `GAG2D_Global_Server`.
3. Spusť `npm install` a potom `npm start`.
4. Otevři http://localhost:3000.

V herním menu klikni na 🌍 TOP, vytvoř účet nebo se přihlas a zvol „Vybrat tuto zahradu do žebříčku“. Počítá se právě otevřený svět a pozemek. Další výběr nahradí předchozí. Žebříčky zobrazují TOP 3 podle mincí, drahokamů a levelu.

## První spuštění a uložený postup

Při prvním otevření vyber jazyk. Pak se přihlas, založ si účet nebo zvol **Možná později**. Jako host můžeš hrát a místně ukládat zahrady. Psaní do chatu a účast v žebříčku vyžadují účet. Přihlásit se můžeš i později přes **TOP**.

Po přihlášení se světy ukládají do prohlížeče i do databáze pod účtem. Po novém přihlášení na stejném serveru se obnoví uložené světy, rostliny a inventář, a to i v jiném prohlížeči. První přihlášení k účtu bez zálohy převezme rozehrané místní světy. Provoz s trvalou databází zajistí, že se záloha neztratí při restartu serveru. Pokud je poslední změna zatím uložená jen v prohlížeči, zkusí se odeslat při dalším přihlášení ze stejného prohlížeče.

## Upozornění
Toto je funkční první verze účtů a žebříčků. Protože původní hra ukládá ekonomiku v prohlížeči, server zatím přijímá hodnoty od klienta a nedokáže zabránit podvádění upraveným prohlížečem. Nepoužívej ji pro soutěže o skutečné ceny. Pro veřejné nasazení je potřeba serverově ověřovat všechny herní transakce a zapnout HTTPS.
Databáze `gag2d.sqlite` vznikne automaticky.

## Společný chat

- V otevřené zahradě najdeš tlačítko **Chat** vlevo od levelu. V nastavení je od začátku viditelné.
- Zprávy mohou číst všichni hráči připojení ke stejnému serveru. Pro psaní použij účet z nabídky **TOP**, který můžeš založit i přes tlačítko **Přihlásit se** v chatu. Zahradu do žebříčku vybírat nemusíš.
- Text začínající lomítkem hra zpracuje jako příkaz v otevřeném světě. Samotné `/` uloží označení **Příkazy použity**. V nastavení můžeš herní příkazy vypnout a chat používat dál.
- Chat zobrazuje posledních 100 zpráv a obnovuje se automaticky, dokud je otevřený.
- Při aktualizaci existujícího serveru ponech soubor `gag2d.sqlite` ve složce serveru. Tabulka pro chat se přidá při spuštění.

### Zprávy, soukromí a příkazy

- Každá zpráva zobrazuje jméno přihlášeného účtu, ze kterého byla odeslána.
- `\say uživatel zpráva` pošle soukromou zprávu. V chatu ji vidí odesílatel a příjemce.
- `\me` zobrazí pouze tobě statistiky otevřeného světa.
- `/say zpráva` odešle veřejnou zprávu stejně jako prostý text.
- Zprávy a statistiky neoznačí svět jako svět s použitými příkazy.
- Server odstraňuje rozpoznané nadávky z veřejných i soukromých zpráv. Pokud po filtrování nezůstane text, zpráva se neodešle.
- V **Nastavení → Chat** můžeš skrýt příchozí zprávy s rozpoznanými odkazy. Nastavení platí pro veřejné i soukromé zprávy.
- Při spuštění nové verze se stávající databáze rozšíří o příjemce soukromých zpráv. Staré veřejné zprávy zůstanou v historii.

## Render Free + Neon Free

Render hostuje hru a Neon uchovává účty, žebříčky, chat i dárky. Vyber tarif Free u obou služeb. Po uspání se hra může načítat pomaleji, data má dál v databázi Neon.

1. Na [Neonu](https://console.neon.tech/) založ projekt na tarifu **Free**. V projektu klikni na **Connect** a zkopíruj připojovací adresu PostgreSQL. Pro hru můžeš použít variantu s **Connection pooling**.
2. Rozbal ZIP. Nahraď soubory ve složce v GitHub repozitáři, odkud se už nasazuje tvoje hra. Vedle `server.js` musí být `database.js`, `package.json`, `package-lock.json` a složka `public`.
3. Na Renderu otevři svoji stávající webovou službu a v **Environment** přidej `DATABASE_URL` s adresou z Neonu. Pro operátora přidej také `GAG_OPERATOR_PASSWORD`. Obě hodnoty jsou tajné.
4. V nastavení služby ponech tarif **Free**. **Build Command** nastav na `npm ci` a **Start Command** na `npm start`. Pokud jsou soubory hry v podsložce, použij ji jako **Root Directory**. Ulož změny a nasaď nejnovější commit. V logu po startu uvidíš označení **PostgreSQL**.
5. Otevři hru na stejné adrese, přihlas se a v **TOP** vyber zahradu. Ověř, že výsledek zůstane v TOP 3 po odhlášení i restartu služby.

Založení tabulek udělá server sám. Bez `DATABASE_URL` můžeš hru spouštět lokálně se SQLite nebo ji používat s dřívějším nastavením `GAG_DATA_DIR`.

- [Render Free a jeho omezení](https://render.com/docs/free)
- [Připojení k Neonu](https://neon.com/docs/connect/connect-from-any-app)
- [Vložení tajných proměnných na Renderu](https://render.com/docs/configure-environment-variables)

### Volitelně převedení zálohy SQLite

Máš-li funkční starou zálohu `gag2d.sqlite`, proveď převod do prázdné databáze Neon **před prvním nasazením nové verze**. Ve složce serveru spusť:

```bash
npm ci
read -rsp "Připojovací adresa Neon: " DATABASE_URL
export DATABASE_URL
npm run migrate:sqlite -- /cesta/k/zaloze/gag2d.sqlite
unset DATABASE_URL
```

Při výzvě k zadání adresy vlož odkaz z **Connect**. Převod zachová účty, žebříčky, chat, bany, zálohy zahrad a čekající změny. Hráči se znovu přihlásí původním heslem. Cílová databáze s účty se nepřepisuje. K obnově dříve smazaných údajů je potřeba záloha.

## Operátor simmmix

V **Environment** nastav tajnou proměnnou `GAG_OPERATOR_PASSWORD`. Hodnotu vlož přímo do nastavení Renderu, mimo HTML, chat a repozitář. Pokud účet `simmmix` dosud neexistuje, server ho založí s tímto heslem. Pokud účet existuje, hodnota musí být jeho současné heslo. Server existující heslo nepřepisuje. Na účet se přihlaš přes **TOP → Přihlásit**.

Přihlášený operátor používá tyto příkazy přímo v chatu.

| Příkaz | Výsledek |
| --- | --- |
| `///ban ratos_23` | Zablokuje účet v online hře a okamžitě zneplatní jeho přihlášení. |
| `///unban ratos_23` | Povolí účtu znovu se přihlásit. |
| `///variable ratos_23 set gem 78` | Nastaví 78 drahokamů. Pro mince použij `coin`. |
| `///give @a seed_carrot 2` | Rozdá dvě semínka mrkve všem registrovaným účtům. |

Jméno účtu vybírá konkrétního hráče. `@a` vybírá všechny registrované účty, `@s` operátora samotného a `@r` jeden náhodný účet. `///unban @r` vybírá jen z účtů s banem. Účet operátora je před banem chráněný.

Změny mincí, drahokamů a semínek se doručí po přihlášení do otevřeného světa. Pokud má hráč právě otevřený pozemek zařazený do žebříčku, změna zůstatku se při uložení projeví i v něm. Uložená doručení se neopakují.

Online verze sdílí účty, chat a žebříčky. Každý hráč si dál hraje ve vlastním světě.

Registrace odmítá existující jména. Heslo běžného účtu zůstává jeho přihlašovacím kódem i po odhlášení. Staré účty s heslem delším než 72 bajtů z původní verze vyžadují obnovu hesla, protože původní bcrypt další bajty neukládal.
