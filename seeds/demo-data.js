// Demo data for `npm run seed`: 1 admin, 3 approved vendors with 20 products,
// and 5 buyers with funded wallets. Prices are integer kobo (NGN 1 = 100 kobo).
// Every account uses DEMO_PASSWORD. This is demo data only: never seed it into
// a real deployment.

const DEMO_PASSWORD = 'KoboMarket#2026';

const img = (slug) => `https://picsum.photos/seed/${slug}/600/600`;

const admin = { email: 'admin@kobomarket.test', name: 'KoboMarket Admin' };

const vendors = [
  {
    email: 'ada@kobomarket.test',
    name: 'Adaeze Okafor',
    store: {
      storeName: "Ada's Fabrics",
      slug: 'adas-fabrics',
      description: 'Ankara, adire and aso-oke, sewn in Aba.',
      bank: { bankCode: '058', accountNumber: '0123456781', accountName: 'Adaeze Okafor' },
    },
    products: [
      {
        name: 'Ankara Tote Bag',
        slug: 'ankara-tote-bag',
        category: 'fashion',
        tags: ['ankara', 'bag'],
        description: 'Hand-sewn tote in bold Ankara print with a lined inner pocket.',
        variants: [
          { sku: 'TOTE-RED', attrs: { colour: 'red' }, priceKobo: 1_250_000, stock: 12 },
          { sku: 'TOTE-BLUE', attrs: { colour: 'blue' }, priceKobo: 1_250_000, stock: 8 },
        ],
      },
      {
        name: 'Adire Silk Scarf',
        slug: 'adire-silk-scarf',
        category: 'fashion',
        tags: ['adire', 'scarf'],
        description: 'Indigo-dyed adire scarf from Abeokuta.',
        priceKobo: 850_000,
        stock: 25,
      },
      {
        name: 'Aso-oke Fila Cap',
        slug: 'aso-oke-fila-cap',
        category: 'fashion',
        tags: ['aso-oke', 'cap'],
        description: 'Traditional woven cap for owambe days.',
        priceKobo: 600_000,
        stock: 30,
      },
      {
        name: 'Ankara Wrap Dress',
        slug: 'ankara-wrap-dress',
        category: 'fashion',
        tags: ['ankara', 'dress'],
        description: 'Knee-length wrap dress, cotton wax print.',
        variants: [
          { sku: 'DRESS-S', attrs: { size: 'S' }, priceKobo: 2_200_000, stock: 5 },
          { sku: 'DRESS-M', attrs: { size: 'M' }, priceKobo: 2_200_000, stock: 7 },
          { sku: 'DRESS-L', attrs: { size: 'L' }, priceKobo: 2_400_000, stock: 4 },
        ],
      },
      {
        name: 'French Lace, 5 Yards',
        slug: 'french-lace-5-yards',
        category: 'fabric',
        tags: ['lace', 'fabric'],
        description: 'Beaded French lace, 5 yards.',
        priceKobo: 4_500_000,
        stock: 10,
      },
      {
        name: 'Kente Bow Tie',
        slug: 'kente-bow-tie',
        category: 'fashion',
        tags: ['kente', 'accessories'],
        description: 'Pre-tied bow tie in kente weave.',
        priceKobo: 350_000,
        stock: 40,
      },
      {
        name: 'Coral Bead Necklace',
        slug: 'coral-bead-necklace',
        category: 'jewellery',
        tags: ['beads', 'necklace'],
        description: 'Hand-strung coral beads for weddings.',
        priceKobo: 1_800_000,
        stock: 6,
      },
    ],
  },
  {
    email: 'tunde@kobomarket.test',
    name: 'Tunde Bakare',
    store: {
      storeName: 'Lagos Gadgets',
      slug: 'lagos-gadgets',
      description: 'Phone accessories and solar power from Computer Village.',
      bank: { bankCode: '044', accountNumber: '0987654321', accountName: 'Tunde Bakare' },
    },
    products: [
      {
        name: '20000mAh Power Bank',
        slug: 'power-bank-20000mah',
        category: 'electronics',
        tags: ['power', 'phone'],
        description: 'Fast-charging power bank for NEPA days.',
        priceKobo: 2_500_000,
        stock: 20,
      },
      {
        name: 'Bluetooth Earbuds',
        slug: 'bluetooth-earbuds',
        category: 'electronics',
        tags: ['audio', 'bluetooth'],
        description: 'Wireless earbuds with charging case.',
        priceKobo: 1_500_000,
        stock: 15,
      },
      {
        name: 'Rugged Phone Case',
        slug: 'rugged-phone-case',
        category: 'electronics',
        tags: ['phone', 'case'],
        description: 'Shockproof case.',
        variants: [
          { sku: 'CASE-IP15', attrs: { model: 'iPhone 15' }, priceKobo: 500_000, stock: 18 },
          { sku: 'CASE-S24', attrs: { model: 'Galaxy S24' }, priceKobo: 450_000, stock: 22 },
          { sku: 'CASE-A15', attrs: { model: 'Galaxy A15' }, priceKobo: 300_000, stock: 30 },
        ],
      },
      {
        name: 'Solar Rechargeable Lamp',
        slug: 'solar-rechargeable-lamp',
        category: 'home',
        tags: ['solar', 'light'],
        description: 'Solar lamp with USB output, 12 hours of light.',
        priceKobo: 1_800_000,
        stock: 14,
      },
      {
        name: 'USB-C 25W Charger',
        slug: 'usb-c-25w-charger',
        category: 'electronics',
        tags: ['charger', 'usb-c'],
        description: 'Wall charger with a 1 m cable.',
        priceKobo: 650_000,
        stock: 50,
      },
      {
        name: 'Fitness Smart Watch',
        slug: 'fitness-smart-watch',
        category: 'electronics',
        tags: ['watch', 'fitness'],
        description: 'Step, sleep and heart-rate tracking.',
        priceKobo: 3_200_000,
        stock: 9,
      },
    ],
  },
  {
    email: 'musa@kobomarket.test',
    name: 'Musa Abdullahi',
    store: {
      storeName: 'Kano Leather Works',
      slug: 'kano-leather-works',
      description: 'Tanned and stitched by hand in Kano.',
      bank: { bankCode: '057', accountNumber: '1122334455', accountName: 'Musa Abdullahi' },
    },
    products: [
      {
        name: 'Leather Sandals',
        slug: 'leather-sandals',
        category: 'footwear',
        tags: ['leather', 'sandals'],
        description: 'Cross-strap sandals in goat leather.',
        variants: [
          { sku: 'SAND-41', attrs: { size: '41' }, priceKobo: 1_400_000, stock: 6 },
          { sku: 'SAND-43', attrs: { size: '43' }, priceKobo: 1_400_000, stock: 8 },
          { sku: 'SAND-45', attrs: { size: '45' }, priceKobo: 1_500_000, stock: 3 },
        ],
      },
      {
        name: 'Leather Messenger Bag',
        slug: 'leather-messenger-bag',
        category: 'bags',
        tags: ['leather', 'bag'],
        description: 'Fits a 14-inch laptop.',
        priceKobo: 4_800_000,
        stock: 5,
      },
      {
        name: 'Slim Leather Wallet',
        slug: 'slim-leather-wallet',
        category: 'accessories',
        tags: ['leather', 'wallet'],
        description: 'Six card slots and a note pocket.',
        priceKobo: 900_000,
        stock: 25,
      },
      {
        name: 'Leather Belt',
        slug: 'leather-belt',
        category: 'accessories',
        tags: ['leather', 'belt'],
        description: 'Full-grain belt with a brass buckle.',
        variants: [
          { sku: 'BELT-32', attrs: { waist: '32' }, priceKobo: 750_000, stock: 10 },
          { sku: 'BELT-36', attrs: { waist: '36' }, priceKobo: 750_000, stock: 10 },
        ],
      },
      {
        name: 'Leather Ottoman Pouf',
        slug: 'leather-ottoman-pouf',
        category: 'home',
        tags: ['leather', 'decor'],
        description: 'Embroidered Moroccan-style pouf.',
        priceKobo: 3_500_000,
        stock: 4,
      },
      {
        name: 'Leather-bound Notebook',
        slug: 'leather-bound-notebook',
        category: 'stationery',
        tags: ['leather', 'notebook'],
        description: 'A5, 200 pages, refillable.',
        priceKobo: 550_000,
        stock: 20,
      },
      {
        name: 'Leather Key Holder',
        slug: 'leather-key-holder',
        category: 'accessories',
        tags: ['leather', 'keys'],
        description: 'Holds six keys.',
        priceKobo: 250_000,
        stock: 35,
      },
    ],
  },
];

// Funded through the ledger (FUNDING from EXTERNAL_PAYSTACK), like a real top-up.
const buyers = [
  { email: 'chioma@kobomarket.test', name: 'Chioma Eze', fundKobo: 50_000_000 },
  { email: 'emeka@kobomarket.test', name: 'Emeka Obi', fundKobo: 25_000_000 },
  { email: 'fatima@kobomarket.test', name: 'Fatima Bello', fundKobo: 100_000_000 },
  { email: 'kunle@kobomarket.test', name: 'Kunle Adeyemi', fundKobo: 10_000_000 },
  { email: 'ngozi@kobomarket.test', name: 'Ngozi Nwosu', fundKobo: 5_000_000 },
];

for (const v of vendors) v.products.forEach((p) => (p.images = [img(p.slug)]));

module.exports = { DEMO_PASSWORD, admin, vendors, buyers };
