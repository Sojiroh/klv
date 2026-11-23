//! Fechas del historial. Misma gramática y mismas decisiones que `utcMicros`, `parseKubeletMicros`
//! y `parseTimeBound` de `packages/web/src/history/` (el resultado es siempre un entero seguro de JS).

use chrono::NaiveDate;

/// Mayor magnitud que un `number` de JS representa sin pérdida (2^53 - 1).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

struct Parts {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

fn digits(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes
        .iter()
        .try_fold(0u32, |acc, b| acc.checked_mul(10)?.checked_add(u32::from(b - b'0')))
}

/// `YYYY-MM-DDTHH:MM:SS` al principio del texto; devuelve el resto.
fn split_prefix(bytes: &[u8]) -> Option<(Parts, &[u8])> {
    if bytes.len() < 19
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let parts = Parts {
        year: i32::try_from(digits(&bytes[0..4])?).ok()?,
        month: digits(&bytes[5..7])?,
        day: digits(&bytes[8..10])?,
        hour: digits(&bytes[11..13])?,
        minute: digits(&bytes[14..16])?,
        second: digits(&bytes[17..19])?,
    };
    Some((parts, &bytes[19..]))
}

/// Microsegundos desde la época de una fecha-hora UTC. `fraction` son los dígitos decimales del
/// segundo (se trunca a microsegundos) y `offset_seconds` se resta. Exige fecha de calendario
/// real, hora 0-23, minuto y segundo 0-59 y un resultado con magnitud <= 2^53 - 1.
fn utc_micros(parts: &Parts, fraction: &[u8], offset_seconds: i64) -> Option<i64> {
    if parts.hour > 23 || parts.minute > 59 || parts.second > 59 {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(parts.year, parts.month, parts.day)?;
    let seconds = date
        .and_hms_opt(parts.hour, parts.minute, parts.second)?
        .and_utc()
        .timestamp()
        .checked_sub(offset_seconds)?;
    let micros = (0..6).fold(0i64, |acc, i| {
        acc * 10 + fraction.get(i).map_or(0, |d| i64::from(d - b'0'))
    });
    let total = seconds.checked_mul(1_000_000)?.checked_add(micros)?;
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&total).then_some(total)
}

/// Prefijo de kubelet `YYYY-MM-DDTHH:MM:SS[.1-9 dígitos][Z]`, siempre UTC.
pub fn parse_kubelet_micros(text: &str) -> Option<i64> {
    let (parts, rest) = split_prefix(text.as_bytes())?;
    let rest = rest.strip_suffix(b"Z").unwrap_or(rest);
    let fraction: &[u8] = match rest {
        [] => &[],
        [b'.', frac @ ..] if (1..=9).contains(&frac.len()) && frac.iter().all(u8::is_ascii_digit) => frac,
        _ => return None,
    };
    utc_micros(&parts, fraction, 0)
}

/// RFC 3339 con desfase explícito (`Z` o `±hh:mm`, hora 0-23 y minuto 0-59); la fracción admite
/// cualquier número de dígitos (>= 1) y se trunca a microsegundos.
pub fn parse_rfc3339_micros(text: &str) -> Option<i64> {
    let (parts, rest) = split_prefix(text.as_bytes())?;
    let (fraction, rest): (&[u8], &[u8]) = match rest {
        [b'.', tail @ ..] => {
            let count = tail.iter().take_while(|b| b.is_ascii_digit()).count();
            if count == 0 {
                return None;
            }
            tail.split_at(count)
        }
        _ => (&[][..], rest),
    };
    let offset_seconds = match rest {
        [b'Z'] => 0,
        [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2] => {
            let hours = i64::from(digits(&[*h1, *h2])?);
            let minutes = i64::from(digits(&[*m1, *m2])?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            let magnitude = hours * 3600 + minutes * 60;
            if *sign == b'-' { -magnitude } else { magnitude }
        }
        _ => return None,
    };
    utc_micros(&parts, fraction, offset_seconds)
}
