import json
import sys

from rapidocr import RapidOCR
from rapidocr.utils.typings import LangRec, OCRVersion

# Cls has only a ch model in RapidOCR's own catalog (no en variant), so only Rec is set to the
# requested language; the shared ch/multi detector locates Latin-script text fine either way.
# The version comes in with the language because the best model differs by script, and which one to
# ask for is the caller's decision, kept in TypeScript where the tests can reach it.
engine = RapidOCR(params={"Rec.lang_type": LangRec(sys.argv[2]), "Rec.ocr_version": OCRVersion(sys.argv[3])})
result = engine(sys.argv[1])
print(json.dumps(result.to_json() or []))
