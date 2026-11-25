const Database = require('better-sqlite3');
const {createDatabase, initialize} = require('./database');

async function migrate(filename) {
    if (!filename || !process.env.DATABASE_URL) {
        console.error('Nastav DATABASE_URL a zadej npm run migrate:sqlite -- /cesta/gag2d.sqlite');
        process.exitCode = 1;
        return;
    }
    const source = new Database(filename,{readonly:true,fileMustExist:true});
    const destination = createDatabase();
    try {
        const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
        if (!tables.has('users')) throw new Error('Zdrojový soubor neobsahuje tabulku users.');
        const {users,messages,gifts,bans,wallet,progress} = source.transaction(() => ({
            users:source.prepare('SELECT id,username,password,selected_garden,coins,gems,level FROM users ORDER BY id').all(),
            messages:tables.has('chat_messages') ? source.prepare('SELECT * FROM chat_messages ORDER BY id').all() : [],
            gifts:tables.has('seed_gifts') ? source.prepare('SELECT * FROM seed_gifts').all() : [],
            bans:tables.has('account_bans') ? source.prepare('SELECT * FROM account_bans').all() : [],
            wallet:tables.has('wallet_changes') ? source.prepare('SELECT * FROM wallet_changes ORDER BY id').all() : [],
            progress:tables.has('account_progress') ? source.prepare('SELECT * FROM account_progress').all() : []
        }))();

        await initialize(destination);
        await destination.transaction(async tx => {
            await tx.exec('LOCK TABLE users, chat_messages, seed_gifts, account_bans, wallet_changes, account_progress IN SHARE ROW EXCLUSIVE MODE');
            const occupied = await tx.prepare('SELECT 1 FROM users LIMIT 1').get();
            if (occupied) throw new Error('Cílová databáze už obsahuje účty. Pro převod zvol prázdnou databázi.');
            const insertUser = tx.prepare(`
                INSERT INTO users(id,username,password,selected_garden,coins,gems,level)
                VALUES (?,?,?,?,?,?,?)
            `);
            for (const user of users) {
                await insertUser.run(user.id,user.username,user.password,user.selected_garden,user.coins,user.gems,user.level);
            }
            const insertMessage = tx.prepare('INSERT INTO chat_messages(id,user_id,body,created_at,recipient_id) VALUES (?,?,?,?,?)');
            for (const message of messages) {
                await insertMessage.run(message.id,message.user_id,message.body,message.created_at,message.recipient_id ?? null);
            }
            const insertGift = tx.prepare('INSERT INTO seed_gifts(id,user_id,seed,amount,created_at) VALUES (?,?,?,?,?)');
            for (const gift of gifts) {
                await insertGift.run(gift.id,gift.user_id,gift.seed,gift.amount,gift.created_at);
            }
            const insertBan = tx.prepare('INSERT INTO account_bans(user_id,banned_at) VALUES (?,?)');
            for (const ban of bans) await insertBan.run(ban.user_id,ban.banned_at);
            const insertWallet = tx.prepare('INSERT INTO wallet_changes(receipt,user_id,currency,amount) VALUES (?,?,?,?)');
            for (const change of wallet) await insertWallet.run(change.receipt,change.user_id,change.currency,change.amount);
            const insertProgress = tx.prepare('INSERT INTO account_progress(user_id,version,payload) VALUES (?,?,?)');
            for (const entry of progress) await insertProgress.run(entry.user_id,entry.version,entry.payload);
            await tx.exec("SELECT setval(pg_get_serial_sequence('users','id'), GREATEST(COALESCE(MAX(id),0),1), MAX(id) IS NOT NULL) FROM users");
            await tx.exec("SELECT setval(pg_get_serial_sequence('chat_messages','id'), GREATEST(COALESCE(MAX(id),0),1), MAX(id) IS NOT NULL) FROM chat_messages");
        });
        console.log(`Převedeno ${users.length} účtů, ${messages.length} zpráv a ${gifts.length} čekajících dárků. Hráči se znovu přihlásí původním heslem.`);
    } finally {
        source.close();
        await destination.close();
    }
}

migrate(process.argv[2]).catch(error => {
    console.error('Převod se nezdařil:',error.code || error.message);
    process.exitCode = 1;
});
