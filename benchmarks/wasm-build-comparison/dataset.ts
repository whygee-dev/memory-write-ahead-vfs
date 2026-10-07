export type SqlValue = number | string | null;

export const DATASET = {
    categories: 1_000,
    categoryFamilies: 20,
    insertRows: 5_000,
    items: 30_000,
    seed: 20_260_407,
} as const;

export const WORKLOAD = {
    cacheSizeKiB: 64 * 1024,
    measuredRounds: 5,
    warmupRounds: 2,
} as const;

const SYLLABLES = [
    'ka',
    'lo',
    'mi',
    'ren',
    'tus',
    'va',
    'dor',
    'pel',
    'qui',
    'sa',
    'ne',
    'bri',
    'zo',
    'fa',
    'gel',
    'hu',
];
const STATUSES = ['active', 'active', 'active', 'pending', 'draft', 'retired', 'archived'];
const TAGS = Array.from({ length: 30 }, (_, index) => `tag-${String(index + 1).padStart(2, '0')}`);

const itemTableSql = (table: string) => `CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    weight_kg REAL,
    width_mm REAL,
    height_mm REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    owner TEXT,
    location TEXT NOT NULL,
    tag TEXT,
    is_active INTEGER NOT NULL,
    score REAL NOT NULL,
    note TEXT
)`;

export const SCHEMA = [
    `CREATE TABLE category (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        family TEXT NOT NULL,
        weight REAL NOT NULL,
        parent_id INTEGER
    )`,
    itemTableSql('item'),
    itemTableSql('item_insert'),
] as const;

export const INDEXES = [
    'CREATE INDEX idx_item_category ON item(category_id)',
    'CREATE INDEX idx_item_insert_category ON item_insert(category_id)',
] as const;

const ITEM_COLUMNS = [
    'id',
    'code',
    'name',
    'description',
    'category_id',
    'status',
    'priority',
    'quantity',
    'unit_price',
    'weight_kg',
    'width_mm',
    'height_mm',
    'created_at',
    'updated_at',
    'owner',
    'location',
    'tag',
    'is_active',
    'score',
    'note',
] as const;

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

export const INSERT_CATEGORY_SQL = `INSERT INTO category (id, name, family, weight, parent_id) VALUES (${placeholders(5)})`;
export const INSERT_ITEM_SQL = `INSERT INTO item (${ITEM_COLUMNS.join(', ')}) VALUES (${placeholders(ITEM_COLUMNS.length)})`;
export const INSERT_WORKLOAD_SQL = `INSERT INTO item_insert (${ITEM_COLUMNS.join(', ')}) VALUES (${placeholders(
    ITEM_COLUMNS.length
)})`;

export const READ_QUERIES = {
    filterScan: `
        SELECT *
        FROM item
        WHERE is_active = 1 AND quantity >= 2500
    `,
    join: `
        SELECT i.id, i.code, i.name, i.unit_price, i.quantity, c.name AS category_name, c.family
        FROM item i
        JOIN category c ON c.id = i.category_id
        WHERE c.family IN ('family-03', 'family-07', 'family-11')
        ORDER BY i.id
    `,
    groupedLeftJoin: `
        SELECT
            c.family,
            c.id,
            COUNT(i.id) AS item_count,
            SUM(i.quantity) AS total_quantity,
            AVG(i.unit_price) AS average_price,
            MAX(i.weight_kg) AS max_weight
        FROM category c
        LEFT JOIN item i ON i.category_id = c.id AND i.status = 'active'
        GROUP BY c.id
        ORDER BY c.family, c.id
    `,
    orderByText: `
        SELECT id, name, code, location
        FROM item
        ORDER BY name, id
    `,
} as const;

export type ReadQueryName = keyof typeof READ_QUERIES;

const createRandom = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
};

type Random = ReturnType<typeof createRandom>;

const pick = <T>(random: Random, values: readonly T[]): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) {
        throw new Error('Cannot pick from an empty list');
    }
    return value;
};
const integer = (random: Random, min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const decimal = (random: Random, max: number) => Math.round(random() * max * 100) / 100;
const nullable = <T>(random: Random, nullRate: number, value: () => T) => (random() < nullRate ? null : value());
const word = (random: Random) => Array.from({ length: integer(random, 2, 4) }, () => pick(random, SYLLABLES)).join('');
const sentence = (random: Random, minWords: number, maxWords: number) =>
    Array.from({ length: integer(random, minWords, maxWords) }, () => word(random)).join(' ');
const title = (random: Random) =>
    `${word(random)} ${word(random)}`.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());

export const generateCategories = (): SqlValue[][] => {
    const random = createRandom(DATASET.seed);
    return Array.from({ length: DATASET.categories }, (_, index) => [
        index + 1,
        title(random),
        `family-${String((index % DATASET.categoryFamilies) + 1).padStart(2, '0')}`,
        decimal(random, 10),
        index < DATASET.categoryFamilies ? null : integer(random, 1, DATASET.categoryFamilies),
    ]);
};

export const generateItems = (count: number, seed: number): SqlValue[][] => {
    const random = createRandom(seed);
    return Array.from({ length: count }, (_, index) => {
        const id = index + 1;
        const createdAt = 1_700_000_000_000 + integer(random, 0, 30_000_000_000);
        return [
            id,
            `ITM-${String(id).padStart(6, '0')}`,
            title(random),
            nullable(random, 0.2, () => sentence(random, 6, 16)),
            integer(random, 1, DATASET.categories),
            pick(random, STATUSES),
            integer(random, 1, 5),
            integer(random, 0, 9_999),
            decimal(random, 1_000),
            nullable(random, 0.1, () => decimal(random, 50)),
            nullable(random, 0.3, () => decimal(random, 2_000)),
            nullable(random, 0.3, () => decimal(random, 2_000)),
            createdAt,
            nullable(random, 0.4, () => createdAt + integer(random, 0, 5_000_000_000)),
            nullable(random, 0.25, () => `user-${integer(random, 1, 400)}`),
            `site-${integer(random, 1, 12)}/floor-${integer(random, 0, 9)}/room-${integer(random, 1, 60)}`,
            nullable(random, 0.5, () => pick(random, TAGS)),
            random() < 0.8 ? 1 : 0,
            decimal(random, 100),
            nullable(random, 0.7, () => sentence(random, 2, 6)),
        ];
    });
};
