import { seed } from '../services/seed.js';
const r = seed({ reset: true });
console.log(`Seeded ${r.orders} orders and ${r.products} products.`);
