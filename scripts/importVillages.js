const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

// Use direct DB connection for imports to prevent pooler exhaustion on huge batch inserts
const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_DATABASE_URL }
  }
});

// -----------------------------------------------------------------------------
// In-Memory Hierarchical Caching
// -----------------------------------------------------------------------------
const countryCache = new Map();
const stateCache = new Map();
const districtCache = new Map();
const subDistrictCache = new Map();

const BATCH_SIZE = 1000;
let villageBatch = [];
let searchBatch = [];
let totalImported = 0;
let failedRows = 0;

// Data Normalization Helper
const clean = (val) => val?.trim();

// Backpressure Helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Dynamically resolves or creates parent hierarchy (State -> District -> SubDistrict).
 * Returns the UUID of the SubDistrict needed for the Village Foreign Key.
 */
async function resolveHierarchy(n) {
  // 1. Country (Hardcoded to India)
  if (!countryCache.has('IN')) {
    const country = await prisma.country.findFirst({ where: { code: 'IN' } });
    if (country) {
      countryCache.set('IN', country.id);
    } else {
      const newCountry = await prisma.country.create({
        data: { code: 'IN', name: 'India' }
      });
      countryCache.set('IN', newCountry.id);
    }
  }
  const countryId = countryCache.get('IN');

  // 2. State
  if (!stateCache.has(n.stateCode)) {
    const state = await prisma.state.findFirst({ where: { code: n.stateCode } });
    if (state) {
      stateCache.set(n.stateCode, state.id);
    } else {
      const newState = await prisma.state.create({
        data: { countryId, code: n.stateCode, name: n.stateName }
      });
      stateCache.set(n.stateCode, newState.id);
    }
  }
  const stateId = stateCache.get(n.stateCode);

  // 3. District
  const distKey = `${stateId}-${n.districtCode}`;
  if (!districtCache.has(distKey)) {
    const district = await prisma.district.findFirst({ where: { code: n.districtCode, stateId } });
    if (district) {
      districtCache.set(distKey, district.id);
    } else {
      const newDistrict = await prisma.district.create({
        data: { stateId, code: n.districtCode, name: n.districtName }
      });
      districtCache.set(distKey, newDistrict.id);
    }
  }
  const districtId = districtCache.get(distKey);

  // 4. Sub-District
  const subDistKey = `${districtId}-${n.subDistrictCode}`;
  if (!subDistrictCache.has(subDistKey)) {
    const subDist = await prisma.subDistrict.findFirst({ where: { code: n.subDistrictCode, districtId } });
    if (subDist) {
      subDistrictCache.set(subDistKey, subDist.id);
    } else {
      const newSubDist = await prisma.subDistrict.create({
        data: { districtId, code: n.subDistrictCode, name: n.subDistrictName }
      });
      subDistrictCache.set(subDistKey, newSubDist.id);
    }
  }
  
  return subDistrictCache.get(subDistKey);
}

/**
 * Flushes 1,000 rows into the database atomically.
 */
async function flushBatches() {
  if (villageBatch.length === 0) return;

  await prisma.$transaction([
    prisma.village.createMany({
      data: villageBatch,
      skipDuplicates: true
    }),
    prisma.villageSearch.createMany({
      data: searchBatch,
      skipDuplicates: true
    })
  ]);

  totalImported += villageBatch.length;
  
  if (totalImported % 10000 === 0) {
    console.log(`\nProgress: ${totalImported}`);
  } else {
    process.stdout.write(`\r✅ Inserted: ${totalImported} villages...`);
  }
}

/**
 * Wraps flushBatches with exponential retry logic to survive temporary NeonDB lock timeouts.
 */
async function flushWithRetry(retries = 3) {
  try {
    await flushBatches();
    // Clear RAM only on success
    villageBatch = [];
    searchBatch = [];
  } catch (err) {
    if (retries > 0) {
      console.log(`\nRetrying batch... (${3 - retries + 1})`);
      await sleep(1000); // Wait 1s before retry
      await flushWithRetry(retries - 1);
    } else {
      console.error(`\n❌ Batch permanently failed. Loss: ${villageBatch.length} rows`);
      console.error(err);
      failedRows += villageBatch.length;
      // Clear RAM on total failure to let stream continue parsing the rest
      villageBatch = [];
      searchBatch = [];
    }
  }
}

/**
 * Core Streaming Pipeline
 */
async function runImport(filePath) {
  console.log(`🚀 Starting high-performance streaming import from ${filePath}\n`);
  console.time('Total Import Duration');

  // Must run: npm install csv-parser
  const stream = fs.createReadStream(filePath).pipe(csv());

  try {
    for await (const row of stream) {
      try {
        // ---------------------------------------------------------------------
        // 1. Data Normalization
        // ---------------------------------------------------------------------
        const normalized = {
          stateCode: clean(row.state_code)?.toUpperCase(),
          stateName: clean(row.state_name),
          districtCode: clean(row.district_code),
          districtName: clean(row.district_name),
          subDistrictCode: clean(row.sub_district_code),
          subDistrictName: clean(row.sub_district_name),
          villageCode: clean(row.village_code),
          villageName: clean(row.village_name),
          population: row.population ? parseInt(clean(row.population), 10) : null,
          pinCode: clean(row.pin_code) || null
        };

        // 2. Ensure parent relationships exist and retrieve Foreign Key
        const subDistrictId = await resolveHierarchy(normalized);

        // 3. Generate UUIDs in Node.js
        const villageId = crypto.randomUUID();

        // 4. Queue Base Village
        villageBatch.push({
          id: villageId,
          subDistrictId: subDistrictId,
          code: normalized.villageCode,
          name: normalized.villageName,
          population: normalized.population,
          pinCode: normalized.pinCode
        });

        // 5. Queue Denormalized Search Projection
        const searchText = `${normalized.villageName} ${normalized.subDistrictName} ${normalized.districtName} ${normalized.stateName}`.toLowerCase().trim();
        searchBatch.push({
          id: crypto.randomUUID(),
          villageId: villageId,
          villageName: normalized.villageName,
          subDistrictName: normalized.subDistrictName,
          districtName: normalized.districtName,
          stateName: normalized.stateName,
          searchText: searchText
        });

        // 6. Bulk Flush to Database
        if (villageBatch.length >= BATCH_SIZE) {
          await flushWithRetry();
          await sleep(10); // Backpressure protection
        }
      } catch (err) {
        console.error(`\n⚠️ Failed to process row: ${row.village_code}`, err.message);
        failedRows++;
      }
    }

    // Flush any remaining records
    if (villageBatch.length > 0) {
      await flushWithRetry();
    }

    console.log('\n\n🎉 Import Complete!');
    console.log(`📊 Total Imported: ${totalImported}`);
    console.log(`⚠️ Failed Rows: ${failedRows}`);
    console.timeEnd('Total Import Duration');

  } catch (err) {
    console.error('\n❌ Fatal Stream Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

// Execution
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/importVillages.js <path-to-dataset.csv>');
  process.exit(1);
}

runImport(filePath);
