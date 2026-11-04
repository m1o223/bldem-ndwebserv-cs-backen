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
      async insertOne(value) {
        if (rows.some(row => row._id === value._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
        rows.push(structuredClone(value));
      },
      async deleteOne(filter) { const i = rows.findIndex(row => match(row, filter)); if (i >= 0) rows.splice(i, 1); },
      async updateOne(filter, update, options = {}) {
        let row = rows.find(row => match(row, filter));
        if (!row && options.upsert) { row = { ...filter, ...update.$setOnInsert }; rows.push(row); }
        if (row) { for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value; }
      },
    };
  } };
}
