const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {createDatabase, initialize, nameMatches} = require('./database');

const app = express();
const db = createDatabase();
let operatorId = null;
if (process.env.RENDER && !process.env.DATABASE_URL && !process.env.GAG_DATA_DIR) {
    console.warn('Nastav DATABASE_URL pro trvalou databázi. Místní soubor na Render Free při restartu zmizí.');
}

app.put('/api/progress',express.json({limit:'8mb'}));
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname,'public')));

const route = handler => (req,res,next) => Promise.resolve(handler(req,res,next)).catch(next);

const clean = (value, min, max) =>
    typeof value === 'string' && value.length >= min && value.length <= max && !/[\x00-\x1f]/.test(value);
const valid = (value, fallback = 0) =>
    value === 'Infinity' ? 1e15 :
        Number.isFinite(Number(value)) ? Math.max(0, Math.min(1e15, Number(value))) : fallback;

const findUserByToken = db.prepare(`
    SELECT * FROM users WHERE token = ?
      AND NOT EXISTS (SELECT 1 FROM account_bans WHERE user_id = users.id)
`);
const findUserByName = db.prepare('SELECT * FROM users WHERE ' + nameMatches(db));
const operatorName = 'simmmix';

function verifyPassword(password, stored) {
    if (typeof password !== 'string' || password.length > 100) return false;
    if (!stored.startsWith('sha256:')) {
        return Buffer.byteLength(password,'utf8') <= 72 && bcrypt.compareSync(password, stored);
    }
    return bcrypt.compareSync(passwordDigest(password), stored.slice(7));
}

function passwordDigest(password) {
    return crypto.createHash('sha256').update(password).digest('base64');
}

function hashPassword(password) {
    return 'sha256:' + bcrypt.hashSync(passwordDigest(password),12);
}

async function configureOperator() {
    const password = process.env.GAG_OPERATOR_PASSWORD;
    if (!password) return null;
    if (password.length < 8 || password.length > 100) {
        console.warn('GAG_OPERATOR_PASSWORD musí mít 8 až 100 znaků. Operátor není aktivní.');
        return null;
    }
    return db.transaction(async tx => {
        if (db.postgres) await tx.exec('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const existing = await tx.prepare('SELECT * FROM users WHERE ' + nameMatches(db)).get(operatorName);
        if (existing) {
            if (verifyPassword(password,existing.password)) return existing.id;
            console.warn('GAG_OPERATOR_PASSWORD se neshoduje s uloženým heslem simmmix. Operátor není aktivní.');
            return null;
        }
        const inserted = await tx.prepare('INSERT INTO users(username,password) VALUES (?,?) RETURNING id')
            .get(operatorName,hashPassword(password));
        return inserted.id;
    });
}

function userFromRequest(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    return token ? findUserByToken.get(token) : null;
}

const auth = route(async (req,res,next) => {
    req.user = await userFromRequest(req);
    if (!req.user) return res.status(401).json({error:'Nejdřív se přihlas.'});
    next();
});

app.post('/api/register', route(async (req,res) => {
    const {username, password} = req.body || {};
    if (!clean(username, 3, 20) || !/^[\p{L}\p{N}_-]+$/u.test(username)) {
        return res.status(400).json({error:'Jméno musí mít 3–20 znaků. Použij písmena, čísla, _ nebo -.'});
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
        return res.status(400).json({error:'Heslo musí mít 8 až 100 znaků.'});
    }
    if (username.toLowerCase() === operatorName) {
        return res.status(409).json({error:'Toto jméno je vyhrazené. Použij přihlášení.'});
    }
    const token = crypto.randomBytes(32).toString('hex');
    try {
        await db.prepare('INSERT INTO users(username, password, token) VALUES(?, ?, ?)')
            .run(username, hashPassword(password), token);
        res.json({username, token});
    } catch (error) {
        if (!['SQLITE_CONSTRAINT_UNIQUE','23505'].includes(error.code)) throw error;
        res.status(409).json({error:'Toto jméno už existuje.'});
    }
}));

app.post('/api/login', route(async (req,res) => {
    const {username, password} = req.body || {};
    const user = typeof username === 'string'
        ? await findUserByName.get(username)
        : null;
    if (!user || !verifyPassword(password,user.password)) {
        return res.status(401).json({error:'Nesprávné jméno nebo heslo.'});
    }
    const token = crypto.randomBytes(32).toString('hex');
    const signedIn = await db.transaction(async tx => {
        await lockOperatorActions(tx);
        if (await tx.prepare('SELECT user_id FROM account_bans WHERE user_id = ?').get(user.id)) return false;
        await tx.prepare('UPDATE users SET token = ? WHERE id = ?').run(token,user.id);
        return true;
    });
    if (!signedIn) return res.status(403).json({error:'Tento účet má ban v online hře.'});
    res.json({username:user.username, token, operator:user.id === operatorId});
}));

const accountProgress = db.prepare('SELECT version,payload FROM account_progress WHERE user_id = ?');
app.get('/api/progress',auth,route(async (req,res) => {
    res.set('Cache-Control','no-store');
    const record = await accountProgress.get(req.user.id);
    res.json({username:req.user.username,version:record?.version ?? 0,save:record?.payload ?? null});
}));

function validProgress(save) {
    if (typeof save !== 'string' || Buffer.byteLength(save) > 4 * 1024 * 1024) return false;
    try {
        const {worlds,activeWorldId} = JSON.parse(save);
        if (!worlds || typeof worlds !== 'object' || Array.isArray(worlds) ||
            typeof activeWorldId !== 'string' || !Object.hasOwn(worlds,activeWorldId)) return false;
        return Object.entries(worlds).every(([id,world]) =>
            /^world_[a-z0-9_]+$/i.test(id) && typeof world?.name === 'string' &&
            Array.isArray(world.game?.plants));
    } catch {
        return false;
    }
}

app.put('/api/progress',auth,route(async (req,res) => {
    res.set('Cache-Control','no-store');
    const {version,save} = req.body || {};
    if (!Number.isSafeInteger(version) || version < 0 || !validProgress(save)) {
        return res.status(400).json({error:'Neplatná nebo příliš velká záloha světů.'});
    }
    const stored = version === 0
        ? await db.prepare(`
            INSERT INTO account_progress(user_id,version,payload) VALUES (?,1,?)
            ON CONFLICT(user_id) DO NOTHING RETURNING version
          `).get(req.user.id,save)
        : await db.prepare(`
            UPDATE account_progress SET payload = ?, version = version + 1
            WHERE user_id = ? AND version = ? RETURNING version
          `).get(save,req.user.id,version);
    if (!stored) return res.status(409).json({error:'Na účtu je novější záloha zahrady.'});
    res.json({version:stored.version});
}));

app.post('/api/select-garden', auth, route(async (req,res) => {
    const {gardenId, coins, gems, level} = req.body || {};
    if (!clean(gardenId, 3, 120)) return res.status(400).json({error:'Neplatná zahrada.'});
    await db.prepare('UPDATE users SET selected_garden = ?, coins = ?, gems = ?, level = ? WHERE id = ?')
        .run(gardenId, valid(coins), valid(gems), valid(level, 1), req.user.id);
    res.json({ok:true});
}));

app.post('/api/update-selected', auth, route(async (req,res) => {
    const {gardenId, coins, gems, level} = req.body || {};
    if (!req.user.selected_garden || (gardenId != null && gardenId !== req.user.selected_garden)) {
        return res.json({ok:true, selected:false});
    }
    await db.prepare('UPDATE users SET coins = ?, gems = ?, level = ? WHERE id = ? AND selected_garden = ?')
        .run(valid(coins),valid(gems),valid(level,1),req.user.id,req.user.selected_garden);
    res.json({ok:true});
}));

const leaderboardColumns = new Set(['coins', 'gems', 'level']);
app.get('/api/leaderboard/:type', route(async (req,res) => {
    const viewer = await userFromRequest(req);
    res.set('Cache-Control', 'no-store');
    const column = req.params.type;
    if (!leaderboardColumns.has(column)) return res.status(404).json({error:'Neznámý žebříček.'});

    const rows = await db.prepare(`
        SELECT username, ${column} AS value
        FROM users
        WHERE selected_garden IS NOT NULL
        ORDER BY ${column} DESC, username
        LIMIT 3
    `).all();
    let mine = null;
    if (viewer?.selected_garden) {
        const value = viewer[column];
        const {rank} = await db.prepare(`
            SELECT COUNT(*) + 1 AS rank
            FROM users
            WHERE selected_garden IS NOT NULL AND ${column} > ?
        `).get(value);
        mine = {rank:Number(rank),value};
    }
    res.json({rows, mine});
}));

const blockedWord = /^(?:kurv[a-z]*|kurev[a-z]*|p[iy]c(?:a|e|i|o|u|ou|am|ach|ami)|p[iy]cov[a-z]*|p[iy]c[iy]n[a-z]*|kokot[a-z]*|zmrd[a-z]*|mrdk[a-z]*|srac[a-z]*|srack[a-z]*|chuj[a-z]*|c[u]rak[a-z]*|buzerant[a-z]*|buzna|debil[a-z]*|kreten[a-z]*|idiot[a-z]*|hajzl[a-z]*|dement(?:i|e|em|ni|u|a|y)?|blbec|blbci|blbce|blbku|blbka|prdel[a-z]*|prdeli|hovn[a-z]*|(?:do|po|pro|vy|od|za|o|s|z)?jeb(?:at|u|es|e|ou|ni|ne|nut[a-z]*|an[a-z]*|anc[a-z]*|ka|ky|te|em|ete)|fuck[a-z]*|motherfuck[a-z]*|shit(?:s|ty|head)?|bullshit|bitch(?:es|y)?|asshole[s]?|bastard[s]?|scheiss[a-z]*|arschloch|wichser|hurensohn)$/iu;
const lookalikes = {'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t'};

function moderateChatText(body) {
    return body.replace(/[\p{L}\p{M}\p{N}\p{Cf}]+/gu, word => {
        const normalized = word.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '');
        const simplified = normalized.replace(/[013457]/g, char => lookalikes[char]).replace(/([a-z])\1{2,}/g, '$1');
        return blockedWord.test(normalized) || blockedWord.test(simplified) ? '' : word;
    }).replace(/ {2,}/g, ' ').trim();
}

function containsChatLink(body) {
    const normalized = body.normalize('NFKC').replace(/\p{Cf}/gu, '');
    return /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:|\bwww\.|(?<![\p{L}\p{N}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-])|\b(?:\d{1,3}\.){3}\d{1,3}(?=[:/]))/iu.test(normalized);
}

const chatHistory = db.prepare(`
    SELECT messages.id, messages.user_id, sender.username, messages.body, recipient.username AS recipient
    FROM chat_messages AS messages
    JOIN users AS sender ON sender.id = messages.user_id
    LEFT JOIN users AS recipient ON recipient.id = messages.recipient_id
    WHERE messages.recipient_id IS NULL OR messages.user_id = ? OR messages.recipient_id = ?
    ORDER BY messages.id DESC
    LIMIT 500
`);
async function publishChatPost(userId,body,recipientId) {
    return db.transaction(async tx => {
        if (db.postgres) await tx.exec('LOCK TABLE chat_messages IN SHARE ROW EXCLUSIVE MODE');
        const now = Date.now();
        const last = await tx.prepare('SELECT created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
        if (last && now - last.created_at < 1000) return false;
        await tx.prepare('INSERT INTO chat_messages(user_id,body,created_at,recipient_id) VALUES (?,?,?,?)')
            .run(userId,body,now,recipientId);
        await tx.prepare('DELETE FROM chat_messages WHERE id <= (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET 500)').run();
        return true;
    });
}

app.get('/api/chat', route(async (req,res) => {
    res.set('Cache-Control', 'no-store');
    const viewer = await userFromRequest(req);
    if (req.headers.authorization && !viewer) return res.status(401).json({error:'Nejdřív se přihlas.'});
    const id = viewer?.id ?? null;
    const messages = [];
    for (const message of await chatHistory.all(id,id)) {
        if (req.query.links === 'hide' && message.user_id !== id && containsChatLink(message.body)) continue;
        const body = moderateChatText(message.body);
        if (!body || (body !== message.body && !/[\p{L}\p{N}\p{S}]/u.test(body))) continue;
        messages.push({id:message.id,username:message.username,body,recipient:message.recipient});
        if (messages.length === 100) break;
    }
    res.json({messages:messages.reverse()});
}));

app.post('/api/chat', auth, route(async (req,res) => {
    const {text,recipient} = req.body || {};
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!clean(raw, 1, 300) || (recipient == null && /^[\\/]/.test(raw))) {
        return res.status(400).json({error:'Zpráva musí mít 1 až 300 znaků.'});
    }
    const body = moderateChatText(raw);
    if (!body || (body !== raw && !/[\p{L}\p{N}\p{S}]/u.test(body))) {
        return res.status(400).json({error:'Po odstranění nadávek ve zprávě nezůstal žádný text.'});
    }
    let recipientId = null;
    if (recipient != null) {
        if (!clean(recipient,3,20) || !/^[\p{L}\p{N}_-]+$/u.test(recipient)) {
            return res.status(400).json({error:'Zadej platné uživatelské jméno.'});
        }
        const user = await findUserByName.get(recipient);
        if (!user) return res.status(404).json({error:'Takový uživatelský účet jsem nenašel.'});
        recipientId = user.id;
    }
    if (!await publishChatPost(req.user.id,body,recipientId)) {
        return res.status(429).json({error:'Před další zprávou počkej jednu sekundu.'});
    }
    res.status(201).json({ok:true});
}));

const reportPresence = db.prepare(`
    INSERT INTO player_presence(user_id,token,seen_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, seen_at=excluded.seen_at
`);
const listGifts = db.prepare('SELECT id,seed,amount FROM seed_gifts WHERE user_id = ? ORDER BY created_at,id LIMIT 100');
const listWalletChanges = db.prepare('SELECT receipt AS id,currency,amount FROM wallet_changes WHERE user_id = ? ORDER BY id LIMIT 100');
const clearPresence = db.prepare('DELETE FROM player_presence WHERE user_id = ? AND token = ?');
const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const walletLimit = 1e15;
const giftSeeds = new Map([
    'carrot','strawberry','radish','daisy','blueberry','tulip','rose','gardenStrawberry','potato','grape',
    'appleTree','pearTree','apricotTree','spruce','clover','halloweenPumpkin','christmasTree','belladonna','lemon'
].map(seed => [seed.toLowerCase(),seed]));
const balanceCurrencies = new Map([['gem','gems'],['gems','gems'],['coin','coins'],['coins','coins']]);
const usernamePattern = /^[\p{L}\p{N}_-]{3,20}$/u;

function parseOperatorCommand(raw) {
    const [verb,target,...args] = (typeof raw === 'string' ? raw.trim() : '').split(/\s+/);
    const action = verb.toLowerCase().slice(3);
    if (!verb.startsWith('///') || !['ban','unban','variable','give'].includes(action)) {
        return {error:'Použij ///ban, ///unban, ///variable nebo ///give.'};
    }
    const selector = target?.startsWith('@') ? target.toLowerCase() : target;
    if (!selector || (!['@a','@s','@r'].includes(selector) && !usernamePattern.test(selector))) {
        return {error:'Zadej jméno účtu nebo použij @a, @s nebo @r.'};
    }
    if (action === 'ban' || action === 'unban') {
        return args.length ? {error:'Za ' + verb + ' patří jen výběr hráče.'} : {action,selector};
    }
    if (action === 'variable') {
        const [operation,currencyToken,value] = args;
        const currency = balanceCurrencies.get(currencyToken?.toLowerCase());
        const amount = Number(value);
        if (args.length !== 3 || operation.toLowerCase() !== 'set' || !currency ||
            !/^\d{1,16}$/.test(value) || !Number.isSafeInteger(amount) || amount > walletLimit) {
            return {error:'Použij ///variable hráč set gem 78 nebo ///variable hráč set coin 78. Povolené jsou nezáporné celé hodnoty do 1 000 000 000 000 000.'};
        }
        return {action,selector,currency,amount};
    }
    const [seedToken,value] = args;
    const seed = seedToken?.toLowerCase().startsWith('seed_') && giftSeeds.get(seedToken.slice(5).toLowerCase());
    const amount = Number(value);
    if (args.length !== 2 || !seed || !/^\d{1,3}$/.test(value) || amount < 1 || amount > 100) {
        return {error:'Použij ///give hráč seed_carrot 2. Vyber druh semínka a počet 1–100.'};
    }
    return {action,selector,seed,amount};
}

async function lockOperatorActions(tx) {
    if (db.postgres) await tx.exec('SELECT pg_advisory_xact_lock(427172)');
}

async function applyOperatorCommand({action,selector,seed,currency,amount},actorId,token) {
    return db.transaction(async tx => {
        await lockOperatorActions(tx);
        const actor = await tx.prepare('SELECT id FROM users WHERE id = ? AND token = ?').get(actorId,token);
        if (!actor) return {status:401,error:'Přihlášení vypršelo.'};
        const targetSql = `
            SELECT users.id, users.username, account_bans.user_id AS banned
            FROM users LEFT JOIN account_bans ON account_bans.user_id = users.id
        `;
        const where = selector === '@s' ? ' WHERE users.id = ?' : ' WHERE ' + nameMatches(db);
        const multiple = selector === '@a' || selector === '@r';
        const candidates = multiple
            ? await tx.prepare(targetSql + ' ORDER BY users.id').all()
            : await tx.prepare(targetSql + where).all(selector === '@s' ? actorId : selector);
        if (!multiple && !candidates.length) return {status:404,error:'Hráč s tímto jménem neexistuje.'};
        if (!multiple && action === 'ban' && candidates[0]?.id === operatorId) {
            return {status:400,error:'Účet operátora nejde zabanovat.'};
        }

        let targets = candidates.filter(player => action === 'ban' ? !player.banned && player.id !== operatorId :
            action === 'unban' ? !!player.banned : true);
        if (selector === '@r' && targets.length) targets = [targets[crypto.randomInt(targets.length)]];

        const now = Date.now();
        for (const {id} of targets) {
            switch (action) {
                case 'ban':
                    await tx.prepare('INSERT INTO account_bans(user_id,banned_at) VALUES (?,?)').run(id,now);
                    await tx.prepare('UPDATE users SET token = NULL WHERE id = ?').run(id);
                    await tx.prepare('DELETE FROM player_presence WHERE user_id = ?').run(id);
                    break;
                case 'unban':
                    await tx.prepare('DELETE FROM account_bans WHERE user_id = ?').run(id);
                    break;
                case 'variable':
                    await tx.prepare('INSERT INTO wallet_changes(receipt,user_id,currency,amount) VALUES (?,?,?,?)')
                        .run(crypto.randomUUID(),id,currency,amount);
                    break;
                case 'give':
                    await tx.prepare('INSERT INTO seed_gifts(id,user_id,seed,amount,created_at) VALUES (?,?,?,?,?)')
                        .run(crypto.randomUUID(),id,seed,amount,now);
                    break;
            }
        }
        return {action,players:targets.length,username:targets.length === 1 ? targets[0].username : undefined,seed,currency,amount};
    });
}

app.post('/api/presence',auth,route(async (req,res) => {
    res.set('Cache-Control','no-store');
    await reportPresence.run(req.user.id,req.user.token,Date.now());
    const wallet = (await listWalletChanges.all(req.user.id)).map(change => ({...change,amount:Number(change.amount)}));
    res.json({gifts:await listGifts.all(req.user.id),wallet,operator:req.user.id === operatorId});
}));

app.post('/api/leave',auth,route(async (req,res) => {
    await clearPresence.run(req.user.id,req.user.token);
    res.json({ok:true});
}));

app.post('/api/gifts/ack',auth,route(async (req,res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || !uuidPattern.test(id))) {
        return res.status(400).json({error:'Neplatné potvrzení dárků.'});
    }
    if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        await db.transaction(async tx => {
            await tx.prepare('DELETE FROM seed_gifts WHERE user_id = ? AND id IN (' + placeholders + ')')
                .run(req.user.id,...ids);
            await tx.prepare('DELETE FROM wallet_changes WHERE user_id = ? AND receipt IN (' + placeholders + ')')
                .run(req.user.id,...ids);
        });
    }
    res.json({ok:true});
}));

app.post('/api/logout',auth,route(async (req,res) => {
    await db.transaction(async tx => {
        await tx.prepare('UPDATE users SET token = NULL WHERE id = ? AND token = ?').run(req.user.id,req.user.token);
        await tx.prepare('DELETE FROM player_presence WHERE user_id = ? AND token = ?').run(req.user.id,req.user.token);
    });
    res.json({ok:true});
}));

app.post('/api/operator/command',auth,route(async (req,res) => {
    if (req.user.id !== operatorId) return res.status(403).json({error:'Tento příkaz může použít jen operátor simmmix.'});
    const command = parseOperatorCommand(req.body?.command);
    if (command.error) return res.status(400).json({error:command.error});
    const result = await applyOperatorCommand(command,req.user.id,req.user.token);
    if (result.error) return res.status(result.status).json({error:result.error});
    res.json(result);
}));

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    const status = error.status === 400 || error.status === 413 ? error.status : 500;
    if (status === 500) console.error('Chyba serveru:',error.code || error.name);
    res.status(status).json({error:status === 500 ? 'Server teď nemohl dokončit požadavek.' : 'Neplatná nebo příliš velká data.'});
});

async function start() {
    await initialize(db);
    operatorId = await configureOperator();
    const port = Number(process.env.PORT) || 3000;
    app.listen(port,'0.0.0.0',() => console.log('Grow a Garden 2D server: http://localhost:' + port + (db.postgres ? ' (PostgreSQL)' : ' (SQLite)')));
}

start().catch(async error => {
    console.error('Databázi nelze připojit nebo připravit. Zkontroluj nastavení databáze a DATABASE_URL.',error.code || error.name);
    await db.close().catch(() => {});
    process.exitCode = 1;
});
