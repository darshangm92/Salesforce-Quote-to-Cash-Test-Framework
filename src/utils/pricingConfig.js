// src/utils/pricingConfig.js
//
// Reading a pricing METHOD's org configuration and refusing to run against a
// version of it the data file does not describe.
//
// WHY A GUARD, AND WHY IT RUNS BEFORE THE BROWSER OPENS
// ----------------------------------------------------
// A block-pricing test asserts that quantity 21 prices at 35 and quantity 20 at
// 25. Both of those are properties of three SBQQ__BlockPrice__c records that
// live in the org and that nothing in this repo creates. If an admin moves a
// tier boundary from 21 to 26, the spec fails at the quantity sweep with
// "expected 35, got 25" — which reads exactly like CPQ resolving the wrong tier
// and sends the next person to debug the calculator instead of the data.
//
// So the configuration is read first and compared against what the data file
// says it is. A mismatch fails in seconds, names the SBQQ__BlockPrice__c record
// and the field, and states what the scenario needed. The alternative is
// fifteen minutes of quote seeding and editor cold-start spent to arrive at a
// misleading message.
//
// THIS IS THE SAME MOVE data/pricing-rules.json's _rulesAsConfigured MAKES,
// one step further. That file records the rule configuration as a comment so a
// reader can tell where a literal like 400 came from; this one checks it. A
// recorded fact drifts silently, a checked one does not.
//
// IT NEVER WRITES. Not a create, not a patch, not a delete — block prices are
// shared org configuration on the sweeper's denylist, and a test that repaired
// its own preconditions would pass against an org it had just changed
// underneath every other suite.
const { escapeSoql } = require('./waitForAsync');
const { moneyEquals } = require('./pricingData');

/** Renders a bound for a message, since the top tier's upper bound is null. */
function bound(value) {
  return value === null || value === undefined ? '(open)' : String(value);
}

/** One SBQQ__BlockPrice__c row, described the way an admin would see it. */
function describeRow(row, overageRateField) {
  return (
    `SBQQ__BlockPrice__c ${row.Id} ("${row.Name}"): ` +
    `SBQQ__LowerBound__c=${bound(row.SBQQ__LowerBound__c)}, ` +
    `SBQQ__UpperBound__c=${bound(row.SBQQ__UpperBound__c)}, ` +
    `SBQQ__Price__c=${row.SBQQ__Price__c}, ` +
    `${overageRateField}=${row[overageRateField] === null ? 'null' : row[overageRateField]}`
  );
}

/**
 * Asserts the org's block-pricing configuration matches the data file.
 *
 * @param {object} sf  the read-only `sf` fixture
 * @param {object} options
 * @param {string} options.productCode        Product2.ProductCode of the block-priced product
 * @param {Array<object>} options.tiers       the data file's `tiers`, each with
 *        { label, lowerBound, upperBound, price, overageRate }
 * @param {string} options.overageRateField   API name of the custom overage rate field
 * @param {string} [options.pricingMethod='Block']
 * @param {string} [options.source]           data file name, for error messages
 * @returns {Promise<{product, pricebookEntry, rows}>} everything it read, for logging
 */
async function assertBlockPricingConfig(sf, options) {
  const {
    productCode,
    tiers,
    overageRateField,
    pricingMethod = 'Block',
    source = 'data/pricing-methods.json',
  } = options;

  if (!productCode) throw new Error('assertBlockPricingConfig needs a productCode.');
  if (!Array.isArray(tiers) || !tiers.length) {
    throw new Error(`assertBlockPricingConfig needs tiers from ${source}.`);
  }
  if (!overageRateField) {
    throw new Error(
      'assertBlockPricingConfig needs the API name of the overage rate field. It is a CUSTOM ' +
        `field on SBQQ__BlockPrice__c, so it cannot be defaulted — record it in ${source}.`
    );
  }

  // ---- the product ---------------------------------------------------------
  const [product] = await sf.query(
    'SELECT Id, Name, ProductCode, IsActive, SBQQ__PricingMethod__c, ' +
      'SBQQ__ConfigurationType__c, SBQQ__ConfigurationEvent__c FROM Product2 ' +
      `WHERE ProductCode = '${escapeSoql(productCode)}' LIMIT 1`
  );

  if (!product) {
    throw new Error(
      `No Product2 with ProductCode = "${productCode}". The block-pricing scenario quotes this ` +
        `product and never creates it — correct the code in ${source}, or point it at a product ` +
        'this org actually has.'
    );
  }
  if (product.SBQQ__PricingMethod__c !== pricingMethod) {
    throw new Error(
      `Product2 ${product.Id} ("${product.Name}", ${productCode}) has ` +
        `SBQQ__PricingMethod__c = '${product.SBQQ__PricingMethod__c}', not '${pricingMethod}'. ` +
        'Every price this scenario asserts comes from a quantity tier, and a product priced any ' +
        'other way resolves its price from its PricebookEntry instead — so the sweep would fail ' +
        'at every quantity with no indication that the pricing METHOD was the cause.'
    );
  }
  if (!product.IsActive) {
    throw new Error(
      `Product2 ${product.Id} ("${product.Name}") is inactive, so it will not appear on the ` +
        'product selection screen at all and the flow would fail while searching for it.'
    );
  }
  // Not fatal, but it changes which flow the caller must use: a configurable
  // product navigates to the configurator instead of returning to the
  // selection screen, so it has to be passed to quoteSimpleProducts as a
  // bundle. Reported rather than thrown, because the spec's own precondition
  // check is what decides — this function's contract is the pricing config.
  if (product.SBQQ__ConfigurationType__c) {
    console.warn(
      `[block pricing] ${productCode} carries SBQQ__ConfigurationType__c = ` +
        `'${product.SBQQ__ConfigurationType__c}' — it is CONFIGURABLE, so adding it opens the ` +
        'bundle configurator rather than returning to the selection screen. It must be passed ' +
        'to quoteSimpleProducts as a bundle, not as a simple product.'
    );
  }

  // ---- the price book entry ------------------------------------------------
  //
  // Read here so the spec can assert its UnitPrice without a second query, and
  // because its ABSENCE is a precondition failure rather than a pricing one: a
  // product with no entry in the standard book cannot be added to the quote at
  // all.
  const [pricebookEntry] = await sf.query(
    'SELECT Id, UnitPrice, IsActive, Pricebook2Id, Pricebook2.Name FROM PricebookEntry ' +
      `WHERE Product2Id = '${escapeSoql(product.Id)}' AND Pricebook2.IsStandard = true LIMIT 1`
  );
  if (!pricebookEntry) {
    throw new Error(
      `No PricebookEntry for ${productCode} in the standard price book. The product cannot be ` +
        'quoted from it, so the selection screen would never offer it.'
    );
  }
  if (!pricebookEntry.IsActive) {
    throw new Error(
      `PricebookEntry ${pricebookEntry.Id} for ${productCode} is inactive — the selection screen ` +
        'will not offer the product.'
    );
  }

  // ---- the tiers -----------------------------------------------------------
  //
  // Ordered by lower bound, which is the order the data file lists them in and
  // the order a tier sweep walks them. Selecting the overage rate field by name
  // is deliberate: it is CUSTOM, so a wrong name comes back as INVALID_FIELD
  // naming the field, which is the good failure here — far better than a silent
  // undefined that reads as "the rate is not populated".
  const soql =
    `SELECT Id, Name, SBQQ__LowerBound__c, SBQQ__UpperBound__c, SBQQ__Price__c, ` +
    `${overageRateField}, SBQQ__PriceBook2__c, SBQQ__EffectiveDate__c ` +
    `FROM SBQQ__BlockPrice__c WHERE SBQQ__Product__c = '${escapeSoql(product.Id)}' ` +
    'ORDER BY SBQQ__LowerBound__c';

  let rows;
  try {
    rows = await sf.query(soql);
  } catch (e) {
    throw new Error(
      `Could not read the block prices for ${productCode}: ${e.message}\n` +
        `  SOQL: ${soql}\n` +
        `If that names an invalid field, this org spells the overage rate field differently than ` +
        `${source} records ("${overageRateField}"). Find its real API name and correct the data ` +
        'file — do not drop the field from the query, because an unread overage rate is exactly ' +
        'what the overage assertions depend on.'
    );
  }

  if (rows.length !== tiers.length) {
    throw new Error(
      `${productCode} has ${rows.length} SBQQ__BlockPrice__c row(s); ${source} describes ` +
        `${tiers.length}. The scenario asserts a price at every tier boundary, so an extra or ` +
        'missing tier changes which quantity resolves to which price.\n' +
        `  In the org: ${rows.map((r) => describeRow(r, overageRateField)).join('\n              ') || '(none)'}`
    );
  }

  rows.forEach((row, index) => {
    const tier = tiers[index];
    const named = `${source} tiers[${index}] ("${tier.label || 'unnamed'}")`;
    const mismatch = (field, expected, actual) => {
      throw new Error(
        `Block pricing for ${productCode} is not configured the way ${named} describes it.\n` +
          `  ${describeRow(row, overageRateField)}\n` +
          `  ${field}: the org has ${bound(actual)}, the scenario needs ${bound(expected)}.\n` +
          'Either the org configuration moved or the data file is stale. Fix whichever is wrong ' +
          'rather than adjusting the expected prices to match — an expectation edited to fit ' +
          'observed behaviour records a broken configuration as correct, and hides it ' +
          'permanently.'
      );
    };

    if (Number(row.SBQQ__LowerBound__c) !== Number(tier.lowerBound)) {
      mismatch('SBQQ__LowerBound__c', tier.lowerBound, row.SBQQ__LowerBound__c);
    }

    // The top tier is open-ended, and null is a MEANINGFUL value there rather
    // than a missing one — it is what makes the overage rate reachable at all.
    const orgUpper = row.SBQQ__UpperBound__c === null || row.SBQQ__UpperBound__c === undefined
      ? null
      : Number(row.SBQQ__UpperBound__c);
    const wantUpper = tier.upperBound === null || tier.upperBound === undefined
      ? null
      : Number(tier.upperBound);
    if (orgUpper !== wantUpper) mismatch('SBQQ__UpperBound__c', wantUpper, orgUpper);

    if (!moneyEquals(row.SBQQ__Price__c, tier.price)) {
      mismatch('SBQQ__Price__c', tier.price, row.SBQQ__Price__c);
    }

    // The overage rate, asserted in BOTH directions. Present where the data
    // file says it should be — an absent rate makes every quantity above the
    // top tier price flat, so the linear progression the scenario proves would
    // silently become a constant. And absent where it says it should not, since
    // a rate on a bounded tier would change prices inside the tiered range.
    const orgRate = row[overageRateField];
    const wantRate = tier.overageRate;
    if (wantRate === null || wantRate === undefined) {
      if (orgRate !== null && orgRate !== undefined) {
        mismatch(`${overageRateField} (should be empty on a bounded tier)`, null, orgRate);
      }
    } else if (orgRate === null || orgRate === undefined) {
      throw new Error(
        `${productCode}'s overage tier has no ${overageRateField}.\n` +
          `  ${describeRow(row, overageRateField)}\n` +
          `  ${named} needs a rate of ${wantRate} per unit above ${bound(tier.lowerBound)}.\n` +
          'Without it every quantity above the top tier prices flat at the tier price, and the ' +
          'per-unit progression this scenario exists to prove cannot happen.'
      );
    } else if (!moneyEquals(orgRate, wantRate)) {
      mismatch(overageRateField, wantRate, orgRate);
    }
  });

  console.log(
    `[block pricing] ${productCode} ("${product.Name}", ${product.Id}) is ` +
      `SBQQ__PricingMethod__c = '${product.SBQQ__PricingMethod__c}', ` +
      `PricebookEntry.UnitPrice = ${pricebookEntry.UnitPrice} in ` +
      `"${pricebookEntry.Pricebook2.Name}", with ${rows.length} tier(s):\n` +
      rows.map((r) => `  ${describeRow(r, overageRateField)}`).join('\n')
  );

  return { product, pricebookEntry, rows };
}

// ===========================================================================
// Percent of total
// ===========================================================================

/**
 * Asserts the percent-of-total product's configuration, and reports the
 * CONTRIBUTORS' pricing methods so a spec can gate its literal checks.
 *
 * The reporting half is the unusual part and it is deliberate. A percent-of-
 * total price is only meaningful as a percentage of what the contributing
 * lines actually netted, so a literal expectation is hostage to every
 * contributor's pricing method. This org already demonstrates it: FIREWALL
 * carries SBQQ__SubscriptionCategory__c = 'Insurance' AND
 * SBQQ__PricingMethod__c = 'Cost', so a literal reasoned from its list price
 * is already wrong. The guard hands that fact back rather than deciding for
 * the caller.
 *
 * @param {object} sf
 * @param {object} options
 * @param {string} options.productCode           the percent-of-total product
 * @param {number} options.percent               SBQQ__SubscriptionPercent__c
 * @param {string} options.base                  SBQQ__SubscriptionBase__c
 * @param {string} options.category              SBQQ__SubscriptionCategory__c
 * @param {string} [options.constraint]          SBQQ__DynamicPricingConstraint__c
 * @param {string[]} [options.contributorCodes]  products expected to CARRY the category
 * @param {string[]} [options.excludedCodes]     products that must NOT carry it
 */
async function assertPercentOfTotalConfig(sf, options) {
  const {
    productCode,
    percent,
    base,
    category,
    constraint,
    contributorCodes = [],
    excludedCodes = [],
    source = 'data/pricing-methods.json',
  } = options;

  const [product] = await sf.query(
    'SELECT Id, Name, ProductCode, IsActive, SBQQ__PricingMethod__c, SBQQ__SubscriptionPercent__c, ' +
      'SBQQ__SubscriptionBase__c, SBQQ__SubscriptionCategory__c, SBQQ__DynamicPricingConstraint__c ' +
      `FROM Product2 WHERE ProductCode = '${escapeSoql(productCode)}' LIMIT 1`
  );
  if (!product) {
    throw new Error(`No Product2 with ProductCode = "${productCode}" (${source}).`);
  }

  const wrong = (field, want, got) => {
    throw new Error(
      `Product2 ${product.Id} ("${product.Name}", ${productCode}) has ${field} = ` +
        `${JSON.stringify(got)}; ${source} needs ${JSON.stringify(want)}. Every price this ` +
        'scenario derives depends on it, so a mismatch would fail the derivation rather than ' +
        'naming the configuration.'
    );
  };

  if (product.SBQQ__PricingMethod__c !== 'Percent Of Total') {
    wrong('SBQQ__PricingMethod__c', 'Percent Of Total', product.SBQQ__PricingMethod__c);
  }
  if (!moneyEquals(product.SBQQ__SubscriptionPercent__c, percent)) {
    wrong('SBQQ__SubscriptionPercent__c', percent, product.SBQQ__SubscriptionPercent__c);
  }
  if (product.SBQQ__SubscriptionBase__c !== base) {
    wrong('SBQQ__SubscriptionBase__c', base, product.SBQQ__SubscriptionBase__c);
  }
  if (product.SBQQ__SubscriptionCategory__c !== category) {
    wrong('SBQQ__SubscriptionCategory__c', category, product.SBQQ__SubscriptionCategory__c);
  }
  if (constraint && product.SBQQ__DynamicPricingConstraint__c !== constraint) {
    wrong('SBQQ__DynamicPricingConstraint__c', constraint, product.SBQQ__DynamicPricingConstraint__c);
  }

  // Who actually carries the category, read live. Membership is what decides
  // the base, so it is checked rather than assumed from the data file.
  const carriers = await sf.query(
    'SELECT Id, Name, ProductCode, SBQQ__SubscriptionCategory__c, SBQQ__PricingMethod__c ' +
      `FROM Product2 WHERE SBQQ__SubscriptionCategory__c = '${escapeSoql(category)}'`
  );
  const carrying = new Set(carriers.map((c) => c.ProductCode));

  const missing = contributorCodes.filter((code) => !carrying.has(code));
  if (missing.length) {
    throw new Error(
      `These products do not carry SBQQ__SubscriptionCategory__c = '${category}' and so contribute ` +
        `nothing to ${productCode}'s base: ${missing.join(', ')}.\n` +
        `  Products that DO carry it: ${[...carrying].join(', ') || '(none)'}\n` +
        `Correct ${source} or the org — a contributor that is not in the category makes the ` +
        'derived price smaller than the scenario expects, for a reason the price itself cannot show.'
    );
  }

  // The exclusion half. This is the ENTIRE point of the control-product test:
  // a silently assigned category would make that test pass while proving the
  // opposite of what it claims.
  const wronglyIncluded = excludedCodes.filter((code) => carrying.has(code));
  if (wronglyIncluded.length) {
    throw new Error(
      `These products are supposed to be OUTSIDE the '${category}' category but carry it: ` +
        `${wronglyIncluded.join(', ')}. The exclusion test asserts that an uncategorized line ` +
        'contributes nothing; with the category assigned it contributes, and the test would pass ' +
        'or fail for reasons unrelated to what it claims to check.'
    );
  }

  // Reported, never enforced — see the note above.
  const contributors = carriers
    .filter((c) => contributorCodes.includes(c.ProductCode))
    .map((c) => ({ productCode: c.ProductCode, pricingMethod: c.SBQQ__PricingMethod__c }));

  console.log(
    `[percent of total] ${productCode} ("${product.Name}"): ${product.SBQQ__SubscriptionPercent__c}% ` +
      `of ${product.SBQQ__SubscriptionBase__c}, category '${product.SBQQ__SubscriptionCategory__c}', ` +
      `constraint '${product.SBQQ__DynamicPricingConstraint__c}'. Contributors: ` +
      `${contributors.map((c) => `${c.productCode}=${c.pricingMethod}`).join(', ') || '(none named)'}`
  );

  const [pricebookEntry] = await sf.query(
    'SELECT Id, UnitPrice, IsActive, Pricebook2.Name FROM PricebookEntry ' +
      `WHERE Product2Id = '${escapeSoql(product.Id)}' AND Pricebook2.IsStandard = true LIMIT 1`
  );

  return {
    product,
    pricebookEntry,
    contributors,
    // True only when every contributor is still on List pricing. A spec gates
    // its literal expectations on this and logs the reason when it is false.
    literalsSafe: contributors.every((c) => c.pricingMethod === 'List' || !c.pricingMethod),
  };
}

// ===========================================================================
// Bundle option pricing
// ===========================================================================

/**
 * Asserts the bundle's option records and — critically — that the Bundled
 * options have NON-ZERO price book entries.
 *
 * That last check is what gives the test its meaning. "Included" is only an
 * override if there was a price to override; if the price book entry were zero
 * the waterfall would be zero anyway and the assertion would prove nothing.
 */
async function assertBundleOptionConfig(sf, options) {
  const {
    bundleCode,
    overrideOption,
    bundledOptions = [],
    source = 'data/pricing-methods.json',
  } = options;

  const [bundle] = await sf.query(
    'SELECT Id, Name, ProductCode, SBQQ__ConfigurationType__c FROM Product2 ' +
      `WHERE ProductCode = '${escapeSoql(bundleCode)}' LIMIT 1`
  );
  if (!bundle) throw new Error(`No Product2 with ProductCode = "${bundleCode}" (${source}).`);
  if (!bundle.SBQQ__ConfigurationType__c) {
    throw new Error(
      `Product2 ${bundle.Id} ("${bundle.Name}", ${bundleCode}) has no ` +
        'SBQQ__ConfigurationType__c, so it is not configurable and has no product options at all. ' +
        'This scenario is about option-level pricing overrides.'
    );
  }

  const optionRows = await sf.query(
    'SELECT Id, Name, SBQQ__OptionalSKU__r.ProductCode, SBQQ__OptionalSKU__r.Name, ' +
      'SBQQ__UnitPrice__c, SBQQ__Bundled__c, SBQQ__Required__c, SBQQ__Feature__r.Name ' +
      `FROM SBQQ__ProductOption__c WHERE SBQQ__ConfiguredSKU__c = '${escapeSoql(bundle.Id)}'`
  );
  const byCode = {};
  for (const row of optionRows) {
    const code = row.SBQQ__OptionalSKU__r && row.SBQQ__OptionalSKU__r.ProductCode;
    if (code) byCode[code] = row;
  }

  const requireOption = (code) => {
    const row = byCode[code];
    if (!row) {
      throw new Error(
        `${bundleCode} has no product option for "${code}". Options present: ` +
          `${Object.keys(byCode).join(', ') || '(none)'} (${source}).`
      );
    }
    return row;
  };

  // ---- the unit price override --------------------------------------------
  const override = requireOption(overrideOption.productCode);
  if (!moneyEquals(override.SBQQ__UnitPrice__c, overrideOption.unitPrice)) {
    throw new Error(
      `SBQQ__ProductOption__c ${override.Id} ("${override.Name}", ${overrideOption.productCode} in ` +
        `${bundleCode}) has SBQQ__UnitPrice__c = ${override.SBQQ__UnitPrice__c}; ${source} needs ` +
        `${overrideOption.unitPrice}. That override IS the price the bundled copy should carry, so ` +
        'the comparison against the standalone copy turns on it.'
    );
  }

  // The standalone price must EXCEED the override, or "prices lower inside the
  // bundle" is not a claim this catalogue can support.
  const standalone = await pricebookUnitPriceById(sf, override.SBQQ__OptionalSKU__r, overrideOption.productCode);
  if (!(standalone > Number(override.SBQQ__UnitPrice__c))) {
    throw new Error(
      `${overrideOption.productCode} costs ${standalone} standalone and its option override is ` +
        `${override.SBQQ__UnitPrice__c}. The scenario claims the bundled copy prices LOWER than the ` +
        'standalone one; with the override at or above the price book price there is no difference ' +
        'to observe, and the test would pass while demonstrating nothing.'
    );
  }

  // ---- the Bundled options -------------------------------------------------
  const bundledDetail = [];
  for (const wanted of bundledOptions) {
    const row = requireOption(wanted.productCode);
    if (row.SBQQ__Bundled__c !== true) {
      throw new Error(
        `SBQQ__ProductOption__c ${row.Id} ("${row.Name}", ${wanted.productCode} in ${bundleCode}) ` +
          `has SBQQ__Bundled__c = ${row.SBQQ__Bundled__c}; ${source} needs true. Without the flag ` +
          'the option prices normally and there is no "Included" behaviour to test.'
      );
    }

    const price = await pricebookUnitPriceById(sf, row.SBQQ__OptionalSKU__r, wanted.productCode);
    if (!(price > 0)) {
      throw new Error(
        `${wanted.productCode} has a standard price book price of ${price}. This scenario asserts ` +
          'that a Bundled option zeroes the whole pricing waterfall — which is only an OVERRIDE if ' +
          'there was a price to override. With a zero price book entry the waterfall would be zero ' +
          'anyway and the assertion would prove nothing.'
      );
    }
    bundledDetail.push({ productCode: wanted.productCode, pricebookPrice: price, option: row });
  }

  console.log(
    `[bundle options] ${bundleCode}: override ${overrideOption.productCode} at ` +
      `${override.SBQQ__UnitPrice__c} against a standalone ${standalone}; bundled ` +
      `${bundledDetail.map((b) => `${b.productCode}@${b.pricebookPrice}`).join(', ')}`
  );

  return { bundle, options: byCode, override, standalonePrice: standalone, bundled: bundledDetail };
}

/** Standard-book unit price for a product already resolved as a relationship. */
async function pricebookUnitPriceById(sf, productRef, productCode) {
  const [entry] = await sf.query(
    'SELECT UnitPrice FROM PricebookEntry WHERE Pricebook2.IsStandard = true ' +
      `AND Product2.ProductCode = '${escapeSoql(productCode)}' AND IsActive = true LIMIT 1`
  );
  if (!entry) {
    throw new Error(
      `No active standard PricebookEntry for "${productCode}" — it cannot be added to a quote ` +
        'from the standard book, so the scenario could never have quoted it.'
    );
  }
  return Number(entry.UnitPrice);
}

// ===========================================================================
// Cost plus markup
// ===========================================================================

async function assertCostPricingConfig(sf, options) {
  const { productCode, unitCost, source = 'data/pricing-methods.json' } = options;

  const [product] = await sf.query(
    'SELECT Id, Name, ProductCode, IsActive, SBQQ__PricingMethod__c FROM Product2 ' +
      `WHERE ProductCode = '${escapeSoql(productCode)}' LIMIT 1`
  );
  if (!product) throw new Error(`No Product2 with ProductCode = "${productCode}" (${source}).`);
  if (product.SBQQ__PricingMethod__c !== 'Cost') {
    throw new Error(
      `Product2 ${product.Id} ("${product.Name}", ${productCode}) has SBQQ__PricingMethod__c = ` +
        `'${product.SBQQ__PricingMethod__c}', not 'Cost'. Cost-plus-markup prices from the ` +
        'SBQQ__Cost__c record; any other method ignores it entirely and the markup would land on ' +
        'a base the scenario has not described.'
    );
  }

  // SBQQ__UnitCost__c is the field name on SBQQ__Cost__c — confirmed by
  // describe on 2026-08-02. There is no SBQQ__UnitPrice__c and no
  // SBQQ__OriginalCost__c on this object; both were tried and returned
  // INVALID_FIELD, which is the good failure and the reason this is written
  // from a describe rather than from memory.
  const costs = await sf.query(
    'SELECT Id, Name, SBQQ__UnitCost__c, SBQQ__Active__c FROM SBQQ__Cost__c ' +
      `WHERE SBQQ__Product__c = '${escapeSoql(product.Id)}'`
  );
  const active = costs.filter((c) => c.SBQQ__Active__c !== false);

  if (!active.length) {
    throw new Error(
      `No active SBQQ__Cost__c record for ${productCode} (${costs.length} inactive found). A ` +
        'Cost-method product with no cost record has nothing to mark up, so every price in this ' +
        'scenario would be derived from a base that does not exist.'
    );
  }
  if (active.length > 1) {
    throw new Error(
      `${productCode} has ${active.length} active SBQQ__Cost__c records: ` +
        `${active.map((c) => `${c.Name}(${c.Id})=${c.SBQQ__UnitCost__c}`).join(', ')}. Which one ` +
        'CPQ picks is not something this scenario should be guessing at.'
    );
  }
  if (!moneyEquals(active[0].SBQQ__UnitCost__c, unitCost)) {
    throw new Error(
      `SBQQ__Cost__c ${active[0].Id} ("${active[0].Name}") for ${productCode} has ` +
        `SBQQ__UnitCost__c = ${active[0].SBQQ__UnitCost__c}; ${source} needs ${unitCost}. Every ` +
        'expected price in this scenario is that cost plus the markup, so they all move together ' +
        'with it — fix whichever of the two is stale rather than editing the expectations.'
    );
  }

  const [pricebookEntry] = await sf.query(
    'SELECT Id, UnitPrice, Pricebook2.Name FROM PricebookEntry ' +
      `WHERE Product2Id = '${escapeSoql(product.Id)}' AND Pricebook2.IsStandard = true LIMIT 1`
  );

  console.log(
    `[cost pricing] ${productCode} ("${product.Name}"): SBQQ__UnitCost__c = ` +
      `${active[0].SBQQ__UnitCost__c}, PricebookEntry.UnitPrice = ` +
      `${pricebookEntry && pricebookEntry.UnitPrice}`
  );

  return { product, cost: active[0], pricebookEntry };
}

// ===========================================================================
// Contracted pricing
// ===========================================================================

/**
 * Asserts both contracted price records on the named account, and that they
 * DO NOT OVERLAP.
 *
 * The non-overlap check is what makes the no-stacking claim testable at all:
 * if the product-specific record's product were also matched by the filter,
 * "the two do not stack" could not be distinguished from "only one of them
 * happened to apply".
 */
async function assertContractedPricingConfig(sf, options) {
  const {
    accountName,
    specific,
    filter,
    source = 'data/pricing-methods.json',
  } = options;

  const rows = await sf.query(
    'SELECT Id, Name, SBQQ__Account__r.Name, SBQQ__Product__r.ProductCode, ' +
      'SBQQ__Product__r.Family, SBQQ__Price__c, SBQQ__Discount__c, SBQQ__FilterField__c, ' +
      'SBQQ__FilterValue__c, SBQQ__Operator__c, SBQQ__EffectiveDate__c, SBQQ__ExpirationDate__c ' +
      `FROM SBQQ__ContractedPrice__c WHERE SBQQ__Account__r.Name = '${escapeSoql(accountName)}'`
  );
  if (!rows.length) {
    throw new Error(
      `No SBQQ__ContractedPrice__c records on Account "${accountName}". This suite never creates ` +
        `them (Section 1.3, read-only configuration) — stage them by hand or point ${source} at ` +
        'an account that already has them.'
    );
  }

  const specificRow = rows.find(
    (r) => r.SBQQ__Product__r && r.SBQQ__Product__r.ProductCode === specific.productCode
  );
  if (!specificRow) {
    throw new Error(
      `No product-specific contracted price for "${specific.productCode}" on "${accountName}". ` +
        `Records present: ${rows.map((r) => `${r.Name}->${(r.SBQQ__Product__r || {}).ProductCode || '(filter)'}`).join(', ')}`
    );
  }
  if (!moneyEquals(specificRow.SBQQ__Price__c, specific.price)) {
    throw new Error(
      `SBQQ__ContractedPrice__c ${specificRow.Id} ("${specificRow.Name}") for ` +
        `${specific.productCode} has SBQQ__Price__c = ${specificRow.SBQQ__Price__c}; ${source} ` +
        `needs ${specific.price}.`
    );
  }

  const filterRow = rows.find((r) => r.SBQQ__FilterField__c);
  if (!filterRow) {
    throw new Error(
      `No filter-based contracted price on "${accountName}" — none of its ` +
        `${rows.length} record(s) carries SBQQ__FilterField__c. The filter half of this scenario ` +
        'is what proves a contracted price can apply without naming a product.'
    );
  }
  const filterMismatch = (field, want, got) => {
    throw new Error(
      `SBQQ__ContractedPrice__c ${filterRow.Id} ("${filterRow.Name}") has ${field} = ` +
        `${JSON.stringify(got)}; ${source} needs ${JSON.stringify(want)}. The set of products the ` +
        'filter matches follows from these three fields, so a mismatch changes which lines the ' +
        'scenario should see discounted.'
    );
  };
  if (filterRow.SBQQ__FilterField__c !== filter.field) {
    filterMismatch('SBQQ__FilterField__c', filter.field, filterRow.SBQQ__FilterField__c);
  }
  if (filterRow.SBQQ__FilterValue__c !== filter.value) {
    filterMismatch('SBQQ__FilterValue__c', filter.value, filterRow.SBQQ__FilterValue__c);
  }
  if (filterRow.SBQQ__Operator__c !== filter.operator) {
    filterMismatch('SBQQ__Operator__c', filter.operator, filterRow.SBQQ__Operator__c);
  }
  if (!moneyEquals(filterRow.SBQQ__Discount__c, filter.discount)) {
    filterMismatch('SBQQ__Discount__c', filter.discount, filterRow.SBQQ__Discount__c);
  }

  // ---- the non-overlap check ----------------------------------------------
  if (filter.field === 'Product Family') {
    const specificFamily = specificRow.SBQQ__Product__r && specificRow.SBQQ__Product__r.Family;
    if (specificFamily === filter.value) {
      throw new Error(
        `${specific.productCode} is in Product Family "${specificFamily}", which is exactly what ` +
          `the filter-based contracted price matches. The scenario's no-stacking claim — that a ` +
          'line matching both gets the flat price and not the flat price less the percentage — ' +
          'cannot be distinguished from "only one applied" when the two overlap by construction.'
      );
    }
  }

  console.log(
    `[contracted pricing] "${accountName}": ${specificRow.Name} sets ${specific.productCode} to ` +
      `${specificRow.SBQQ__Price__c}; ${filterRow.Name} discounts ` +
      `${filterRow.SBQQ__FilterField__c} ${filterRow.SBQQ__Operator__c} ` +
      `"${filterRow.SBQQ__FilterValue__c}" by ${filterRow.SBQQ__Discount__c}%. ` +
      `Expirations: ${rows.map((r) => `${r.Name}=${r.SBQQ__ExpirationDate__c || 'none'}`).join(', ')}`
  );

  return { rows, specific: specificRow, filter: filterRow };
}

// ===========================================================================
// Contracted price expiration
// ===========================================================================

/**
 * Asserts a contracted price exists and its expiration is ALREADY IN THE PAST.
 *
 * This is the precondition for the whole expiration scenario, and it has to be
 * checked rather than assumed for a reason peculiar to this test: the claim is
 * that an expired price does NOT apply, and "does not apply" is exactly what
 * you also observe when the record was never there, when it names a different
 * product, or when the expiry has not passed yet. All three of those would
 * make the test pass while proving nothing.
 *
 * So the guard establishes that there IS a contracted price for this product,
 * that it WOULD have priced the line at a distinctive value, and that its
 * window has closed. Only then is "the line came back at list price"
 * meaningful.
 *
 * READ-ONLY. It never edits the expiration date to set up its own scenario —
 * the record is shared org configuration and the staging is done by hand.
 */
async function assertExpiredContractedPrice(sf, options) {
  const {
    accountName,
    productCode,
    contractedPrice,
    source = 'data/pricing-methods.json',
  } = options;

  const [row] = await sf.query(
    'SELECT Id, Name, SBQQ__Price__c, SBQQ__EffectiveDate__c, SBQQ__ExpirationDate__c, ' +
      'SBQQ__Product__r.ProductCode FROM SBQQ__ContractedPrice__c ' +
      `WHERE SBQQ__Account__r.Name = '${escapeSoql(accountName)}' ` +
      `AND SBQQ__Product__r.ProductCode = '${escapeSoql(productCode)}' LIMIT 1`
  );

  if (!row) {
    throw new Error(
      `No SBQQ__ContractedPrice__c for "${productCode}" on Account "${accountName}". The ` +
        'expiration scenario needs one whose window has already closed — without it, "the ' +
        'contracted price did not apply" is true because there is no contracted price at all, ' +
        `which proves nothing. Stage it by hand; this suite never creates one (${source}).`
    );
  }

  if (!row.SBQQ__ExpirationDate__c) {
    throw new Error(
      `SBQQ__ContractedPrice__c ${row.Id} ("${row.Name}") for ${productCode} has NO ` +
        'SBQQ__ExpirationDate__c, so it never expires and the scenario has nothing to observe. ' +
        'Set one in the past by hand.'
    );
  }

  // Date-only comparison, in UTC, against the same calendar day the org uses.
  // A time-of-day comparison would make a price that expired "today" read as
  // still live for part of the run.
  const today = new Date().toISOString().slice(0, 10);
  if (row.SBQQ__ExpirationDate__c >= today) {
    throw new Error(
      `SBQQ__ContractedPrice__c ${row.Id} ("${row.Name}") for ${productCode} expires on ` +
        `${row.SBQQ__ExpirationDate__c}, which is NOT in the past (today is ${today}). The ` +
        'scenario asserts that an EXPIRED price stops applying; while the window is still open ' +
        'the price should apply, and this test would fail for the right reason at the wrong time. ' +
        'Move the expiration date back, or run this after it lapses.'
    );
  }

  if (contractedPrice !== undefined && !moneyEquals(row.SBQQ__Price__c, contractedPrice)) {
    throw new Error(
      `SBQQ__ContractedPrice__c ${row.Id} ("${row.Name}") sets ${productCode} to ` +
        `${row.SBQQ__Price__c}; ${source} records ${contractedPrice}. That number is what the ` +
        'grandfathered line should still carry, so the two have to agree.'
    );
  }

  console.log(
    `[contracted expiration] ${row.Name} sets ${productCode} to ${row.SBQQ__Price__c}, expired ` +
      `${row.SBQQ__ExpirationDate__c} (today ${today}) — so a line priced from today must NOT get it.`
  );
  return row;
}

// ===========================================================================
// Optional quote lines
// ===========================================================================

/**
 * Asserts SBQQ__Optional__c exists on the quote LINE and, if asked, on the
 * quote line GROUP.
 *
 * A describe rather than a query: the field's existence is the precondition,
 * and querying it on a record that does not exist yet would conflate "the
 * field is missing" with "there is no data".
 */
async function assertOptionalFieldAvailable(sf, options = {}) {
  const {
    lineField = 'SBQQ__Optional__c',
    groupField = 'SBQQ__Optional__c',
    requireGroupField = true,
    source = 'data/optional-lines.json',
  } = options;

  const probe = async (sobject, field) => {
    try {
      await sf.query(`SELECT Id, ${field} FROM ${sobject} LIMIT 1`);
      return true;
    } catch (e) {
      if (/INVALID_FIELD|No such column/i.test(e.message)) return false;
      throw e;
    }
  };

  if (!(await probe('SBQQ__QuoteLine__c', lineField))) {
    throw new Error(
      `SBQQ__QuoteLine__c has no field "${lineField}" in this org. The whole scenario is about ` +
        `marking a line optional, so there is nothing to drive — correct the name in ${source}.`
    );
  }

  const groupFieldPresent = await probe('SBQQ__QuoteLineGroup__c', groupField);
  if (requireGroupField && !groupFieldPresent) {
    throw new Error(
      `SBQQ__QuoteLineGroup__c has no field "${groupField}" in this org, so the group-level ` +
        'cascade half of this scenario has nothing behind it. Either the field is named ' +
        `differently or this org does not expose Optional at group level; correct ${source} rather ` +
        'than dropping the assertion, because a cascade that writes nothing looks identical to a ' +
        'cascade that has not run yet.'
    );
  }

  console.log(
    `[optional lines] SBQQ__QuoteLine__c.${lineField} present; ` +
      `SBQQ__QuoteLineGroup__c.${groupField} ${groupFieldPresent ? 'present' : 'ABSENT'}.`
  );
  return { lineField, groupField, groupFieldPresent };
}

module.exports = {
  assertBlockPricingConfig,
  assertPercentOfTotalConfig,
  assertBundleOptionConfig,
  assertCostPricingConfig,
  assertContractedPricingConfig,
  assertExpiredContractedPrice,
  assertOptionalFieldAvailable,
};
