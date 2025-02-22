import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDriver, query, queryUnsafe, closePool } from "../../src/db.js";
import { listTables, inspectTable } from "../../src/analyzers/schema.js";
import { analyzeIndexUsage, findMissingIndexes } from "../../src/analyzers/indexes.js";
import { explainQuery } from "../../src/analyzers/query.js";
import { analyzeTableBloat } from "../../src/analyzers/bloat.js";
import { suggestMissingIndexes } from "../../src/analyzers/suggestions.js";
import { analyzeSlowQueries } from "../../src/analyzers/slow-queries.js";
import { analyzeConnections } from "../../src/analyzers/connections.js";
import { analyzeTableRelationships } from "../../src/analyzers/relationships.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://test:test@localhost:15432/testdb";

describe("PostgreSQL Integration Tests — All 8 Tools", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB_URL;
    await initDriver("postgres");

    // Create realistic schema: users, products, orders, order_items, reviews
    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        category VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        total DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        quantity INTEGER NOT NULL DEFAULT 1,
        price DECIMAL(10,2) NOT NULL
      )
    `);

    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Orphan table (no FK references)
    await queryUnsafe(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action VARCHAR(50) NOT NULL,
        payload JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Indexes
    await queryUnsafe(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await queryUnsafe(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
    await queryUnsafe(`CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id)`);
    await queryUnsafe(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);

    // Insert test data
    await queryUnsafe(`
      INSERT INTO users (email, name)
      SELECT 'user' || g || '@test.com', 'User ' || g
      FROM generate_series(1, 100) g
      ON CONFLICT DO NOTHING
    `);

    await queryUnsafe(`
      INSERT INTO products (name, price, category)
      SELECT 'Product ' || g, (random() * 100)::decimal(10,2),
             CASE g % 4 WHEN 0 THEN 'electronics' WHEN 1 THEN 'books' WHEN 2 THEN 'clothing' ELSE 'food' END
      FROM generate_series(1, 50) g
      ON CONFLICT DO NOTHING
    `);

    await queryUnsafe(`
      INSERT INTO orders (user_id, total, status)
      SELECT (g % 100) + 1, (random() * 200)::decimal(10,2),
             CASE g % 3 WHEN 0 THEN 'pending' WHEN 1 THEN 'shipped' ELSE 'delivered' END
      FROM generate_series(1, 500) g
      ON CONFLICT DO NOTHING
    `);

    await queryUnsafe(`
      INSERT INTO order_items (order_id, product_id, quantity, price)
      SELECT (g % 500) + 1, (g % 50) + 1, (g % 5) + 1, (random() * 50)::decimal(10,2)
      FROM generate_series(1, 1000) g
      ON CONFLICT DO NOTHING
    `);

    await queryUnsafe(`
      INSERT INTO reviews (user_id, product_id, rating, comment)
      SELECT (g % 100) + 1, (g % 50) + 1, (g % 5) + 1, 'Review comment ' || g
      FROM generate_series(1, 200) g
      ON CONFLICT DO NOTHING
    `);

    await queryUnsafe(`
      INSERT INTO audit_log (action, payload)
      SELECT 'event_' || g, '{"key": "value"}'::jsonb
      FROM generate_series(1, 50) g
    `);
  }, 30000);

  afterAll(async () => {
    await queryUnsafe("DROP TABLE IF EXISTS order_items CASCADE");
    await queryUnsafe("DROP TABLE IF EXISTS reviews CASCADE");
    await queryUnsafe("DROP TABLE IF EXISTS orders CASCADE");
    await queryUnsafe("DROP TABLE IF EXISTS products CASCADE");
    await queryUnsafe("DROP TABLE IF EXISTS users CASCADE");
    await queryUnsafe("DROP TABLE IF EXISTS audit_log CASCADE");
    await closePool();
  });

  // Tool 1: inspect_schema
  describe("inspect_schema", () => {
    it("listTables returns all 6 test tables", async () => {
      const result = await listTables("public");
      expect(result).toContain("users");
      expect(result).toContain("orders");
      expect(result).toContain("products");
      expect(result).toContain("order_items");
      expect(result).toContain("reviews");
      expect(result).toContain("audit_log");
    });

    it("inspectTable returns columns and constraints", async () => {
      const result = await inspectTable("orders", "public");
      expect(result).toContain("Table: public.orders");
      expect(result).toContain("user_id");
      expect(result).toContain("status");
      expect(result).toContain("FOREIGN KEY");
    });

    it("inspectTable returns not found for missing table", async () => {
      const result = await inspectTable("nonexistent", "public");
      expect(result).toContain("not found");
    });
  });

  // Tool 2: analyze_indexes
  describe("analyze_indexes", () => {
    it("returns index stats with created indexes", async () => {
      const result = await analyzeIndexUsage("public");
      expect(result).toContain("Index Usage Analysis");
    });

    it("findMissingIndexes runs without error", async () => {
      const result = await findMissingIndexes("public");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // Tool 3: explain_query
  describe("explain_query", () => {
    it("explains a SELECT query", async () => {
      const result = await explainQuery(
        "SELECT * FROM users WHERE email = 'user1@test.com'"
      );
      expect(result).toContain("Query Plan Analysis");
      expect(result).toContain("Plan Tree");
    });

    it("explains JOIN query", async () => {
      const result = await explainQuery(
        "SELECT u.name, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE o.status = 'pending'"
      );
      expect(result).toContain("Query Plan Analysis");
    });

    it("explains with ANALYZE for SELECT", async () => {
      const result = await explainQuery(
        "SELECT * FROM orders WHERE status = 'pending'",
        true
      );
      expect(result).toContain("Execution Time");
    });

    it("rejects DELETE in analyze mode", async () => {
      const result = await explainQuery("DELETE FROM users", true);
      expect(result).toContain("only allowed on pure SELECT");
    });

    it("rejects CTE with DELETE in analyze mode", async () => {
      const result = await explainQuery(
        "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x",
        true
      );
      expect(result).toContain("only allowed on pure SELECT");
    });
  });

  // Tool 4: analyze_table_bloat
  describe("analyze_table_bloat", () => {
    it("returns bloat analysis", async () => {
      const result = await analyzeTableBloat("public");
      expect(result).toContain("Table Bloat Analysis");
    });
  });

  // Tool 5: suggest_missing_indexes
  describe("suggest_missing_indexes", () => {
    it("returns index suggestions", async () => {
      const result = await suggestMissingIndexes("public");
      expect(result).toContain("Index Suggestions");
    });
  });

  // Tool 6: analyze_slow_queries
  describe("analyze_slow_queries", () => {
    it("returns result without crashing", async () => {
      const result = await analyzeSlowQueries("public", 10);
      // pg_stat_statements may not be installed in test container
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // Tool 7: analyze_connections
  describe("analyze_connections", () => {
    it("returns connection analysis with states", async () => {
      const result = await analyzeConnections();
      expect(result).toContain("Connection Analysis (PostgreSQL)");
      expect(result).toContain("Connection States");
    });
  });

  // Tool 8: analyze_table_relationships
  describe("analyze_table_relationships", () => {
    it("detects FK relationships", async () => {
      const result = await analyzeTableRelationships("public");
      expect(result).toContain("Table Relationships");
      expect(result).toContain("orders");
      expect(result).toContain("users");
    });

    it("detects orphan table (audit_log)", async () => {
      const result = await analyzeTableRelationships("public");
      expect(result).toContain("Orphan");
      expect(result).toContain("audit_log");
    });

    it("detects cascade chains", async () => {
      const result = await analyzeTableRelationships("public");
      // users → orders (CASCADE) → order_items (CASCADE)
      expect(result).toContain("Cascading");
    });
  });
});
