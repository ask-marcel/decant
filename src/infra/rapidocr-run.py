import json
import sys

from rapidocr import RapidOCR
from rapidocr.utils.typings import LangRec

# Cls has only a ch model in RapidOCR's own catalog (no en variant), so only Rec is set to the
# requested language; the shared ch/multi detector locates Latin-script text fine either way.
engine = RapidOCR(params={"Rec.lang_type": LangRec(sys.argv[2])})
result = engine(sys.argv[1])
print(json.dumps(result.to_json() or []))
