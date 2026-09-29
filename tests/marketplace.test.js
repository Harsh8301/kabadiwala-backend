const assert = require('node:assert/strict');
const { canBuy, passwordHash, verifyPassword, pool } = require('../lib/marketplace');

assert.equal(canBuy('COLLECTOR','AGGREGATOR'),true);
assert.equal(canBuy('COLLECTOR','MIDDLEMAN'),true);
assert.equal(canBuy('COLLECTOR','RECYCLER'),true);
assert.equal(canBuy('AGGREGATOR','MIDDLEMAN'),true);
assert.equal(canBuy('MIDDLEMAN','RECYCLER'),true);
assert.equal(canBuy('RECYCLER','COLLECTOR'),false);
assert.equal(canBuy('AGGREGATOR','COLLECTOR'),false);
assert.equal(canBuy('COLLECTOR','ADMIN'),false);
const stored = passwordHash('a secure password');
assert.equal(verifyPassword('a secure password',stored),true);
assert.equal(verifyPassword('wrong password',stored),false);
pool.end().then(() => console.log('Marketplace role and password checks passed'));
