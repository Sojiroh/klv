//! Historial local: colector continuo + DuckDB con segmentos Parquet por hora.

mod collector;
mod db;
mod legacy;
mod search;
mod service;
pub mod types;
mod writer;

pub use service::HistoryState;
