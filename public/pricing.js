// Estimates a dress's retail price and suggests a deposit and rental price.
// Shared by the server (require) and the browser (window.TCPricing) so both give the same numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TCPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Typical retail price (USD) for a formal / party dress from each brand. Rough averages, not exact.
  const BRANDS = {
    'shein': 25, 'fashion nova': 35, 'forever 21': 30, 'amazon': 35, 'h&m': 40, 'hm': 40, 'windsor': 50,
    'hollister': 50, 'edikted': 50, 'zara': 60, 'nasty gal': 60, 'princess polly': 65, 'lulus': 70, 'asos': 70,
    'urban outfitters': 70, 'showpo': 75, 'hello molly': 75, 'mango': 80, 'oh polly': 85, 'abercrombie': 90,
    'express': 90, 'meshki': 110, 'bebe': 120, 'tommy hilfiger': 120, 'calvin klein': 140, 'aritzia': 150,
    'free people': 150, 'j crew': 150, 'jcrew': 150, 'banana republic': 150, 'ann taylor': 150, 'vince camuto': 150,
    'bardot': 150, 'birdy grey': 150, 'davids bridal': 150, 'white house black market': 160, 'azazie': 160,
    'adrianna papell': 180, 'anthropologie': 180, 'house of cb': 200, 'revolve': 200, 'majorelle': 230,
    'lovers and friends': 220, 'lovers friends': 220, 'reformation': 250, 'bcbg': 250, 'bcbgmaxazria': 250,
    'for love and lemons': 250, 'for love lemons': 250, 'faviana': 250, 'dress the population': 250,
    'ralph lauren': 250, 'jenny yoo': 280, 'rat and boa': 300, 'rat boa': 300, 'selkie': 300, 'la femme': 350,
    'ganni': 350, 'staud': 350, 'mac duggal': 400, 'halston': 400, 'self portrait': 450, 'alice olivia': 450,
    'alice and olivia': 450, 'loveshackfancy': 450, 'cinq a sept': 450, 'badgley mischka': 450, 'tadashi shoji': 450,
    'jovani': 450, 'sherri hill': 550,
  };
  // Typical price for an unknown brand, by length.
  const LENGTH_BASE = { 'Mini': 80, 'Knee': 100, 'Midi': 120, 'Tea': 140, 'Floor-length': 180 };
  // A known brand's price adjusted by length (gowns cost more than minis).
  const LENGTH_ADJ = { 'Mini': 0.85, 'Knee': 0.95, 'Midi': 1, 'Tea': 1.05, 'Floor-length': 1.2 };
  // Fabric / detail words in the title or description.
  const KEYWORDS = [
    [/\b(sequin|sequins|sequined|beaded|embellished|crystal)\b/, 1.25, 'embellished'],
    [/\bsilk\b/, 1.3, 'silk'],
    [/\bvelvet\b/, 1.1, 'velvet'],
    [/\b(tulle|chiffon|organza)\b/, 1.1, 'tulle/chiffon'],
    [/\blace\b/, 1.1, 'lace'],
    [/\bsatin\b/, 1.05, 'satin'],
    [/\b(corset|corseted|boned)\b/, 1.1, 'corset'],
    [/\bgown\b/, 1.1, 'gown'],
    [/\b(vintage|thrifted|secondhand)\b/, 0.85, 'vintage'],
  ];
  const CONDITIONS = {
    new_tags:  { label: 'New with tags', factor: 0.95 },
    like_new:  { label: 'Like new (worn once)', factor: 0.85 },
    excellent: { label: 'Excellent (worn a few times)', factor: 0.75 },
    good:      { label: 'Good (light wear)', factor: 0.6 },
    fair:      { label: 'Fair (visible wear)', factor: 0.45 },
  };

  const norm = (s) => String(s || '').toLowerCase().replace(/[’'.]/g, '').replace(/[^a-z0-9&]+/g, ' ').trim();
  const round5 = (n) => Math.round(n / 5) * 5;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function findBrand(designer) {
    const d = ' ' + norm(designer) + ' ';
    let best = null;
    for (const [name, price] of Object.entries(BRANDS)) {
      if (d.includes(' ' + name + ' ') && (!best || name.length > best.name.length)) best = { name, price };
    }
    return best;
  }

  // Returns { retail, retailEstimated, brand, reasons[], value, deposit, rental }.
  function estimate({ designer, length, title, description, condition, originalPrice } = {}) {
    const reasons = [];
    let retail, retailEstimated = true;
    const brand = findBrand(designer);
    const op = Number(originalPrice);
    if (op > 0) {
      retail = Math.round(op); retailEstimated = false; reasons.push('your original price');
    } else {
      if (brand) { retail = brand.price * (LENGTH_ADJ[length] || 1); reasons.push(designer.trim()); }
      else { retail = LENGTH_BASE[length] || 120; reasons.push(designer && designer.trim() ? 'brand not in our list' : 'no brand given'); }
      if (length) reasons.push(length.toLowerCase());
      const text = norm(title) + ' ' + norm(description);
      let mult = 1;
      for (const [re, m, label] of KEYWORDS) if (re.test(text)) { mult *= m; reasons.push(label); }
      retail = round5(retail * clamp(mult, 0.7, 1.6));
    }
    const c = CONDITIONS[condition];
    const value = round5(retail * (c ? c.factor : 0.75));
    return {
      retail, retailEstimated, brand: brand && brand.name, reasons,
      condition: c ? c.label : null, value,
      deposit: clamp(round5(value * 0.5), 20, 500),   // about half of what the dress is worth now
      rental: clamp(round5(value * 0.15), 10, 150),   // about 15% of its current value
    };
  }

  return { estimate, CONDITIONS, BRANDS };
});
