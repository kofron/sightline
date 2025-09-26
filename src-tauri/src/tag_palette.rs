//! Static palette for tag highlighting. Values are expressed in CSS OKLCH
//! notation so the frontend can apply them directly.

const PALETTE: [&str; 16] = [
    "oklch(0.78 0.20 25)",
    "oklch(0.80 0.19 55)",
    "oklch(0.82 0.18 90)",
    "oklch(0.83 0.17 120)",
    "oklch(0.82 0.16 150)",
    "oklch(0.80 0.17 180)",
    "oklch(0.79 0.18 210)",
    "oklch(0.78 0.19 235)",
    "oklch(0.77 0.20 260)",
    "oklch(0.78 0.19 285)",
    "oklch(0.80 0.18 310)",
    "oklch(0.81 0.18 330)",
    "oklch(0.83 0.17 345)",
    "oklch(0.84 0.16 10)",
    "oklch(0.82 0.18 40)",
    "oklch(0.79 0.19 70)",
];

/// Returns a CSS color string for the provided tag identifier.
#[inline]
pub fn color_for(id: u32) -> &'static str {
    let index = (id as usize) % PALETTE.len();
    PALETTE[index]
}
