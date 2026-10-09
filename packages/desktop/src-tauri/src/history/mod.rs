//! Historial local: colector continuo + SQLite (contrato Q5).

mod collector;
mod db;
mod search;
mod service;
pub mod types;
mod writer;

pub use service::HistoryState;
