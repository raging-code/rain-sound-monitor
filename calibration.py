"""
Calibration helpers: ignore spikes, average what is left, and convert raw
readings into percentages.
"""

import statistics


def robust_mean(values, tolerance):
    """Average of values after throwing the spikes away.

    A reading counts as a spike when it is further from the median than
    max(3 x MAD, tolerance). MAD (median absolute deviation) is a measure of
    spread that one clap or one splash cannot distort.
    Returns None when there are no values.
    """
    values = [float(v) for v in values]
    if not values:
        return None
    median = statistics.median(values)
    mad = statistics.median([abs(v - median) for v in values]) * 1.4826
    limit = max(3.0 * mad, float(tolerance))
    kept = [v for v in values if abs(v - median) <= limit]
    return {
        "mean": statistics.fmean(kept),
        "median": median,
        "kept": len(kept),
        "discarded": len(values) - len(kept),
        "total": len(values),
        "limit": limit,
    }


def sound_percent(swing, baseline, full_scale):
    """Sound swing (ADC counts) to 0-100 %. The calibrated quiet level is 0 %."""
    span = max(1.0, float(full_scale) - float(baseline))
    return max(0.0, min(100.0, (float(swing) - float(baseline)) / span * 100.0))


def moisture_percent(raw, dry, wet):
    """Rain ADC reading to 0-100 % moisture. The calibrated dry level is 0 %."""
    span = max(1.0, float(dry) - float(wet))
    return max(0.0, min(100.0, (float(dry) - float(raw)) / span * 100.0))


def effective_full_scale(full_scale, sensitivity, baseline=0.0, max_gain=4.0, min_span=10.0):
    """Swing (ADC counts) that reads 100 %, after the sensitivity setting.

    sensitivity runs from 0 to 100 and 50 keeps full_scale as it is. Moving it
    up makes the sensor react to quieter sounds (up to max_gain times more
    easily at 100); moving it down makes it react less (up to max_gain times
    less easily at 0). The result stays at least min_span counts above the
    quiet level and never goes past the largest possible swing (1023).
    """
    try:
        level = float(sensitivity)
    except (TypeError, ValueError):
        level = 50.0
    level = max(0.0, min(100.0, level))
    gain = float(max_gain) ** ((level - 50.0) / 50.0)
    scaled = max(float(full_scale) / gain, float(baseline) + float(min_span))
    return min(scaled, 1023.0)
