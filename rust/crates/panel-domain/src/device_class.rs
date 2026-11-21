//! The viewport width classes heatmaps are grouped by (`device-class.ts`):
//! under 768 px mobile, under 1024 px tablet, else desktop.

/// Below this width a viewport is mobile.
pub const MOBILE_MAX_WIDTH: i64 = 768;
/// Below this width (and from [`MOBILE_MAX_WIDTH`]) a viewport is a tablet.
pub const TABLET_MAX_WIDTH: i64 = 1024;
