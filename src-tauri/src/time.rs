//! UTC time formatting with the standard library only (no chrono/time dependency).

use std::time::{SystemTime, UNIX_EPOCH};

/// Broken-down UTC time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtcTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millis: u32,
}

impl UtcTime {
    pub fn now() -> Self {
        let d = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        Self::from_unix_millis(d.as_millis() as i64)
    }

    pub fn from_unix_millis(ms: i64) -> Self {
        let secs = ms.div_euclid(1000);
        let millis = ms.rem_euclid(1000) as u32;
        let days = secs.div_euclid(86_400);
        let sod = secs.rem_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        UtcTime {
            year,
            month,
            day,
            hour: (sod / 3600) as u32,
            minute: ((sod % 3600) / 60) as u32,
            second: (sod % 60) as u32,
            millis,
        }
    }

    /// `YYYYMMDD-HHMMSS`, used in snapshot and export folder names.
    pub fn compact(&self) -> String {
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    /// ISO 8601 UTC with milliseconds, same shape as JS `Date.toISOString()`.
    pub fn iso(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }
}

/// Howard Hinnant's days-from-epoch → civil date algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        let t = UtcTime::from_unix_millis(0);
        assert_eq!(t.iso(), "1970-01-01T00:00:00.000Z");
        // 2024-02-29T13:05:09.123Z (leap day)
        let t = UtcTime::from_unix_millis(1_709_211_909_123);
        assert_eq!(t.iso(), "2024-02-29T13:05:09.123Z");
        assert_eq!(t.compact(), "20240229-130509");
        // 2000-12-31T23:59:59.999Z
        let t = UtcTime::from_unix_millis(978_307_199_999);
        assert_eq!(t.iso(), "2000-12-31T23:59:59.999Z");
    }
}
