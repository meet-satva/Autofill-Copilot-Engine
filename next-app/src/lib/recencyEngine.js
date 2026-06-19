// Determines the "Active Master Document" from a set of grouped variants

export function arbitrateRecency(variants) {
  if (variants.length === 0) return [];

  if (variants.length === 1) {
    return [
      {
        ...variants[0],
        status: 'active_master',
        determinedDate: variants[0].parsedData?.dateOfIssue || new Date().toISOString(),
        dateSource: 'single_document',
      },
    ];
  }

  console.log(`\n  📊 Arbitrating ${variants.length} variants by recency...`);

  const variantsWithDates = variants.map((v, idx) => {
    const parsedData = v.parsedData || {};

    let date;
    let dateSource;
    if (!parsedData.name) {
      date = new Date(0);
      dateSource = 'no_name';
    } else if (parsedData.dateOfIssue) {
      date = parseDate(parsedData.dateOfIssue);
      dateSource = 'dateOfIssue';
    } else if (parsedData.registrationDate) {
      date = parseDate(parsedData.registrationDate);
      dateSource = 'registrationDate';
    } else if (parsedData.dob) {
      date = parseDate(parsedData.dob);
      dateSource = 'dob';
    } else {
      date = new Date(1);
      dateSource = 'unknown';
    }

    return {
      ...v,
      determinedDate: date?.toISOString(),
      dateSource,
      parsedDate: date,
      variantIndex: idx,
    };
  });

  variantsWithDates.sort((a, b) => (b.parsedDate || 0) - (a.parsedDate || 0));

  return variantsWithDates.map((v, idx) => ({
    ...v,
    status: idx === 0 ? 'active_master' : 'archived_older_version',
  }));
}


export const pickBestVariant = (parsedVariants) => {
  const scored = parsedVariants.map(v => ({
    ...v,
    score: Object.values(v.parsedData).filter(val => val !== null && val !== '').length,
  }));
  scored.sort((a, b) => b.score - a.score);
  console.log('  📊 Variant scores:', scored.map(v => `${v.personName}:${v.score}`));
  return scored[0];
}

function parseDate(dateStr) {
  if (!dateStr) return null;

  const ddmmyyyy = /(\d{2})\/(\d{2})\/(\d{4})/.exec(dateStr);
  if (ddmmyyyy) {
    return new Date(ddmmyyyy[3], parseInt(ddmmyyyy[2]) - 1, ddmmyyyy[1]);
  }

  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? null : parsed;
}