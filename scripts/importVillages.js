require('dotenv').config();

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const crypto = require('crypto');
const { PrismaClient, Prisma } = require('@prisma/client');

const dbUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('DIRECT_DATABASE_URL or DATABASE_URL is required.');
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: {
    db: { url: dbUrl }
  }
});

const STATE_CODE_BY_MDDS = {
  '01': 'JK',
  '02': 'HP',
  '03': 'PB',
  '04': 'CH',
  '05': 'UK',
  '06': 'HR',
  '07': 'DL',
  '08': 'RJ',
  '09': 'UP',
  '10': 'BR',
  '11': 'SK',
  '12': 'AR',
  '13': 'NL',
  '14': 'MN',
  '15': 'MZ',
  '16': 'TR',
  '17': 'ML',
  '18': 'AS',
  '19': 'WB',
  '20': 'JH',
  '21': 'OD',
  '22': 'CG',
  '23': 'MP',
  '24': 'GJ',
  '25': 'DD',
  '26': 'DN',
  '27': 'MH',
  '28': 'AP',
  '29': 'KA',
  '30': 'GA',
  '31': 'LD',
  '32': 'KL',
  '33': 'TN',
  '34': 'PY',
  '35': 'AN'
};

const BATCH_SIZE = Number.parseInt(process.env.IMPORT_BATCH_SIZE || '1000', 10);
const MAX_RETRIES = Number.parseInt(process.env.IMPORT_MAX_RETRIES || '5', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.IMPORT_RETRY_DELAY_MS || '1000', 10);

const countryCache = new Map();
const stateCache = new Map();
const districtCache = new Map();
const subDistrictCache = new Map();

let villageBatch = [];
let totalRows = 0;
let skippedRows = 0;
let totalQueued = 0;
let totalFlushed = 0;
let failedRows = 0;
let duplicateRows = 0;
let currentBatchKeys = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clean = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(/\s+/g, ' ');
  return normalized || null;
};

const getField = (row, names) => {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return clean(row[name]);
  }

  const normalizedHeaders = Object.keys(row).reduce((acc, key) => {
    acc[key.replace(/^\uFEFF/, '').trim().toLowerCase()] = key;
    return acc;
  }, {});

  for (const name of names) {
    const key = normalizedHeaders[name.replace(/^\uFEFF/, '').trim().toLowerCase()];
    if (key) return clean(row[key]);
  }

  return null;
};

const normalizeCode = (value, width = 0) => {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const digitsOnly = cleaned.replace(/\.0$/, '');
  return width > 0 && /^\d+$/.test(digitsOnly) ? digitsOnly.padStart(width, '0') : digitsOnly;
};

const normalizeSearchText = (...parts) => {
  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const parsePopulation = (value) => {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const parsed = Number.parseInt(cleaned.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizePinCode = (value) => {
  const cleaned = clean(value);
  if (!cleaned) return null;
  const digits = cleaned.replace(/\D/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
};

function normalizeRow(row) {
  const mddsStateCode = normalizeCode(getField(row, ['MDDS STC', 'state_mdds_code', 'state_code']), 2);
  const stateCode = STATE_CODE_BY_MDDS[mddsStateCode] || getField(row, ['state_alpha_code', 'state_code'])?.toUpperCase();
  const stateName = getField(row, ['STATE NAME', 'state_name']);
  const districtCode = normalizeCode(getField(row, ['MDDS DTC', 'district_code']));
  const districtName = getField(row, ['DISTRICT NAME', 'district_name']);
  const subDistrictCode = normalizeCode(getField(row, ['MDDS Sub_DT', 'sub_district_code']));
  const subDistrictName = getField(row, ['SUB-DISTRICT NAME', 'sub_district_name']);
  const villageCode = normalizeCode(getField(row, ['MDDS PLCN', 'village_code']));
  const villageName = getField(row, ['Area Name', 'village_name', 'area_name']);

  if (!stateCode || !stateName || !districtCode || !districtName || !subDistrictCode || !subDistrictName || !villageCode || !villageName) {
    return { skip: true, reason: 'missing required hierarchy or village field' };
  }

  if (districtCode === '0' || subDistrictCode === '0' || villageCode === '0') {
    return { skip: true, reason: 'hierarchy aggregate row' };
  }

  return {
    stateCode,
    stateName,
    districtCode,
    districtName,
    subDistrictCode,
    subDistrictName,
    villageCode,
    villageName,
    population: parsePopulation(getField(row, ['population', 'Population'])),
    pinCode: normalizePinCode(getField(row, ['pin_code', 'PIN Code', 'pincode']))
  };
}

async function findOrCreate(model, cache, key, findWhere, createData) {
  if (cache.has(key)) return cache.get(key);

  const existing = await prisma[model].findFirst({
    where: findWhere,
    select: { id: true }
  });

  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  try {
    const created = await prisma[model].create({
      data: createData,
      select: { id: true }
    });
    cache.set(key, created.id);
    return created.id;
  } catch (error) {
    if (error.code !== 'P2002') throw error;

    const retryExisting = await prisma[model].findFirst({
      where: findWhere,
      select: { id: true }
    });

    if (!retryExisting) throw error;
    cache.set(key, retryExisting.id);
    return retryExisting.id;
  }
}

async function resolveHierarchy(row) {
  const countryId = await findOrCreate(
    'country',
    countryCache,
    'IN',
    { code: 'IN', deletedAt: null },
    { code: 'IN', name: 'India' }
  );

  const stateId = await findOrCreate(
    'state',
    stateCache,
    `${countryId}:${row.stateCode}`,
    { countryId, code: row.stateCode, deletedAt: null },
    { countryId, code: row.stateCode, name: row.stateName }
  );

  const districtId = await findOrCreate(
    'district',
    districtCache,
    `${stateId}:${row.districtCode}`,
    { stateId, code: row.districtCode, deletedAt: null },
    { stateId, code: row.districtCode, name: row.districtName }
  );

  return findOrCreate(
    'subDistrict',
    subDistrictCache,
    `${districtId}:${row.subDistrictCode}`,
    { districtId, code: row.subDistrictCode, deletedAt: null },
    { districtId, code: row.subDistrictCode, name: row.subDistrictName }
  );
}

async function flushBatches() {
  if (villageBatch.length === 0) return;

  const rows = villageBatch;
  const villageValues = Prisma.join(rows.map((row) => Prisma.sql`(
    ${row.id}::uuid,
    ${row.subDistrictId}::uuid,
    ${row.villageCode},
    ${row.villageName},
    ${row.population},
    ${row.pinCode}
  )`));

  const searchValues = Prisma.join(rows.map((row) => Prisma.sql`(
    ${row.subDistrictId}::uuid,
    ${row.villageCode},
    ${row.searchId}::uuid,
    ${row.villageName},
    ${row.subDistrictName},
    ${row.districtName},
    ${row.stateName},
    ${row.searchText}
  )`));

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO village (id, sub_district_id, code, name, population, pin_code)
      VALUES ${villageValues}
      ON CONFLICT DO NOTHING
    `,
    prisma.$executeRaw`
      INSERT INTO village_search (
        id,
        village_id,
        village_name,
        sub_district_name,
        district_name,
        state_name,
        search_text
      )
      SELECT
        input.search_id,
        village.id,
        input.village_name,
        input.sub_district_name,
        input.district_name,
        input.state_name,
        input.search_text
      FROM (
        VALUES ${searchValues}
      ) AS input (
        sub_district_id,
        village_code,
        search_id,
        village_name,
        sub_district_name,
        district_name,
        state_name,
        search_text
      )
      JOIN village
        ON village.sub_district_id = input.sub_district_id
       AND village.code = input.village_code
       AND village.deleted_at IS NULL
      ON CONFLICT (village_id) DO UPDATE SET
        village_name = EXCLUDED.village_name,
        sub_district_name = EXCLUDED.sub_district_name,
        district_name = EXCLUDED.district_name,
        state_name = EXCLUDED.state_name,
        search_text = EXCLUDED.search_text
    `
  ], { timeout: 60000 });

  totalFlushed += rows.length;
  villageBatch = [];
  currentBatchKeys = new Set();

  if (totalFlushed % 10000 === 0) {
    console.log(`Imported/search-indexed ${totalFlushed} villages`);
  } else {
    process.stdout.write(`\rImported/search-indexed ${totalFlushed} villages...`);
  }
}

async function flushWithRetry() {
  let attempt = 0;

  while (true) {
    try {
      await flushBatches();
      return;
    } catch (error) {
      attempt += 1;
      if (attempt > MAX_RETRIES) {
        console.error('\nBatch failed permanently. Import stopped before data loss.');
        console.error(error);
        throw error;
      }

      const waitMs = RETRY_DELAY_MS * attempt;
      console.warn(`\nBatch failed. Retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms: ${error.message}`);
      await sleep(waitMs);
    }
  }
}

async function repairMissingSearchRows() {
  const inserted = await prisma.$executeRaw`
    INSERT INTO village_search (
      id,
      village_id,
      village_name,
      sub_district_name,
      district_name,
      state_name,
      search_text
    )
    SELECT
      gen_random_uuid(),
      village.id,
      village.name,
      sub_district.name,
      district.name,
      state.name,
      regexp_replace(
        lower(
          concat_ws(
            ' ',
            village.name,
            sub_district.name,
            district.name,
            state.name,
            state.code
          )
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    FROM village
    JOIN sub_district
      ON sub_district.id = village.sub_district_id
     AND sub_district.deleted_at IS NULL
    JOIN district
      ON district.id = sub_district.district_id
     AND district.deleted_at IS NULL
    JOIN state
      ON state.id = district.state_id
     AND state.deleted_at IS NULL
    LEFT JOIN village_search
      ON village_search.village_id = village.id
    WHERE village.deleted_at IS NULL
      AND village_search.village_id IS NULL
  `;

  if (inserted > 0) {
    console.log(`Backfilled ${inserted} missing village_search rows.`);
  }
}

async function processCsv(filePath) {
  console.log(`Importing ${filePath}`);
  const stream = fs.createReadStream(filePath).pipe(csv());

  for await (const row of stream) {
    totalRows += 1;
    const normalized = normalizeRow(row);

    if (normalized.skip) {
      skippedRows += 1;
      continue;
    }

    try {
      const subDistrictId = await resolveHierarchy(normalized);
      const batchKey = `${subDistrictId}:${normalized.villageCode}`;

      if (currentBatchKeys.has(batchKey)) {
        duplicateRows += 1;
        continue;
      }

      currentBatchKeys.add(batchKey);
      const villageId = crypto.randomUUID();

      villageBatch.push({
        id: villageId,
        subDistrictId,
        villageCode: normalized.villageCode,
        villageName: normalized.villageName,
        population: normalized.population,
        pinCode: normalized.pinCode,
        searchId: crypto.randomUUID(),
        subDistrictName: normalized.subDistrictName,
        districtName: normalized.districtName,
        stateName: normalized.stateName,
        searchText: normalizeSearchText(
          normalized.villageName,
          normalized.subDistrictName,
          normalized.districtName,
          normalized.stateName
        )
      });

      totalQueued += 1;

      if (villageBatch.length >= BATCH_SIZE) {
        await flushWithRetry();
      }
    } catch (error) {
      failedRows += 1;
      console.error(`\nFailed row ${totalRows} (${normalized.villageCode || 'unknown'}): ${error.message}`);
      throw error;
    }
  }
}

function resolveInputFiles(inputPath) {
  let resolved = path.resolve(inputPath);

  if (!fs.existsSync(resolved) && path.basename(inputPath) === 'india_villages.csv') {
    resolved = path.resolve(path.dirname(inputPath));
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Input path does not exist: ${inputPath}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) return [resolved];

  return fs.readdirSync(resolved)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .sort()
    .map((file) => path.join(resolved, file));
}

async function validateImport() {
  await repairMissingSearchRows();

  const [counts] = await prisma.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM village WHERE deleted_at IS NULL) AS "villages",
      (SELECT COUNT(*)::int FROM village_search) AS "searchRows",
      (
        SELECT COUNT(*)::int
        FROM village v
        LEFT JOIN village_search vs ON vs.village_id = v.id
        WHERE v.deleted_at IS NULL AND vs.village_id IS NULL
      ) AS "missingSearchRows",
      (
        SELECT COUNT(*)::int
        FROM village_search vs
        LEFT JOIN village v ON v.id = vs.village_id
        WHERE v.id IS NULL
      ) AS "orphanSearchRows"
  `;

  console.log('\nValidation:');
  console.log(`Villages: ${counts.villages}`);
  console.log(`Village search rows: ${counts.searchRows}`);
  console.log(`Villages missing search row: ${counts.missingSearchRows}`);
  console.log(`Orphan village_search rows: ${counts.orphanSearchRows}`);

  if (counts.missingSearchRows !== 0) {
    throw new Error('Import completed with missing village_search rows.');
  }

  if (counts.orphanSearchRows !== 0) {
    throw new Error('Import completed with orphan village_search rows.');
  }

  const stateCoverage = await prisma.$queryRaw`
    SELECT
      state.code,
      COUNT(village.id)::int AS "villageCount",
      COUNT(village_search.id)::int AS "searchCount"
    FROM state
    LEFT JOIN district
      ON district.state_id = state.id
     AND district.deleted_at IS NULL
    LEFT JOIN sub_district
      ON sub_district.district_id = district.id
     AND sub_district.deleted_at IS NULL
    LEFT JOIN village
      ON village.sub_district_id = sub_district.id
     AND village.deleted_at IS NULL
    LEFT JOIN village_search
      ON village_search.village_id = village.id
    WHERE state.deleted_at IS NULL
    GROUP BY state.code, state.name
    ORDER BY state.code
  `;

  console.log('State Coverage:');
  stateCoverage.forEach((row) => {
    console.log(`${row.code} -> ${row.villageCount} villages, ${row.searchCount} search rows`);
  });

  ['RJ', 'MH', 'DL'].forEach((code) => {
    const coverage = stateCoverage.find((row) => row.code === code);
    if (!coverage || coverage.villageCount === 0) {
      console.warn(`WARNING: ${code} has 0 villages. Dataset is incomplete for this state.`);
    }
  });
}

async function runImport(inputPath) {
  console.time('Total import duration');
  const files = resolveInputFiles(inputPath);

  console.log(`Files: ${files.length}`);
  console.log('Loaded files:');
  files.forEach((file) => {
    console.log(`- ${path.basename(file)}`);
  });

  for (const file of files) {
    await processCsv(file);
  }

  await flushWithRetry();
  await validateImport();

  console.log('\nImport complete.');
  console.log(`CSV rows read: ${totalRows}`);
  console.log(`Hierarchy/non-village rows skipped: ${skippedRows}`);
  console.log(`Villages queued: ${totalQueued}`);
  console.log(`Villages flushed: ${totalFlushed}`);
  console.log(`Duplicate village rows skipped within batch: ${duplicateRows}`);
  console.log(`Failed rows: ${failedRows}`);
  console.timeEnd('Total import duration');
}

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node scripts/importVillages.js <path-to-csv-or-directory>');
  process.exit(1);
}

runImport(inputPath)
  .catch((error) => {
    console.error('\nFatal import error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
