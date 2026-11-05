export function memoryDatabase() {
  const collections = new Map();
  function match(row, filter) {
    return Object.entries(filter).every(([key, value]) => value && typeof value === "object" && "$gt" in value ? row[key] > value.$gt : String(row[key]) === String(value));
  }
  return { collections, collection(name) {
    if (!collections.has(name)) collections.set(name, []);
    const rows = collections.get(name);
    return {
      async createIndex() {},
      async findOne(filter) { return rows.find(row => match(row, filter)) || null; },
      find(filter) {
        let result = rows.filter(row => match(row, filter));
        return { sort(spec) { const [key, order] = Object.entries(spec)[0]; result.sort((a, b) => (a[key] > b[key] ? 1 : -1) * order); return this; }, limit(count) { result = result.slice(0, count); return this; }, async toArray() { return structuredClone(result); } };
      },
      async insertOne(value) {
        if (rows.some(row => row._id === value._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        rows.push(structuredClone(value));
      },
      async deleteOne(filter) { const i = rows.findIndex(row => match(row, filter)); if (i >= 0) rows.splice(i, 1); },
      async deleteMany(filter) { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], filter)) rows.splice(i, 1); },
      async findOneAndDelete(filter) { const i = rows.findIndex(row => match(row, filter)); return i >= 0 ? rows.splice(i, 1)[0] : null; },
      async updateOne(filter, update, options = {}) {
        let row = rows.find(row => match(row, filter));
        if (!row && options.upsert) { row = { ...filter, ...update.$setOnInsert }; rows.push(row); }
        if (row) { Object.assign(row, structuredClone(update.$set || {})); for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value; }
        return { matchedCount: row ? 1 : 0 };
      },
    };
  } };
}
