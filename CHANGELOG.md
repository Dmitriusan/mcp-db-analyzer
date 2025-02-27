# Changelog

All notable changes to MCP DB Analyzer will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-03-08

### Added
- `analyze_vacuum` tool: PostgreSQL vacuum health analysis — dead tuple detection, autovacuum config checks, never-vacuumed table detection
- 15 new tests for vacuum analysis

## [0.1.0] - 2026-03-06

### Added
- MCP server for database performance analysis
- PostgreSQL support with pg driver
- MySQL support with mysql2 driver
- SQLite support with better-sqlite3 driver
- `--driver` CLI flag for database type selection
- Schema analysis: tables, columns, types, constraints, relationships
- Index analysis: missing indexes, unused indexes, optimization suggestions
- Query plan inspection via EXPLAIN ANALYZE
- Slow query identification and optimization recommendations
- Integration test setup with Docker Compose (PostgreSQL)
- npm-ready packaging with shebang and bin entry
