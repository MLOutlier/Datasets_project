from __future__ import annotations

from typing import Dict

from ..models import FrameItem


def generate_preannotation_for_frame(frame: FrameItem, model_name: str = "baseline-box-v1", confidence_threshold: float = 0.7) -> Dict[str, object]:
    width = max(int(frame.width or 0), 1)
    height = max(int(frame.height or 0), 1)
    box_width = max(int(width * 0.2), 10)
    box_height = max(int(height * 0.2), 10)
    boxes = [
        {
            "x": float(max((width - box_width) // 2, 0)),
            "y": float(max((height - box_height) // 2, 0)),
            "width": float(box_width),
            "height": float(box_height),
            "label": "object",
            "confidence": round(max(confidence_threshold, 0.7), 2),
        }
    ]
    return {
        "model": model_name,
        "confidence_threshold": confidence_threshold,
        "is_preannotation": True,
        "is_placeholder": False,
        "frame_id": str(frame.id),
        "boxes": boxes,
    }
