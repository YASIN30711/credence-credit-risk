"""
Credence — Credit Risk Assessment API.

/predict is the original project logic, unchanged.
/explain computes per-applicant SHAP attributions with a native TreeExplainer
(XGBoost's built-in SHAP path), then folds the one-hot expanded contributions
back onto the 11 original features.

The saved model is CalibratedClassifierCV(cv=5) around a
Pipeline(Preprocessor -> XGBClassifier), i.e. five fitted XGBoost pipelines.
/explain explains each of them and averages the attributions.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import shap  # NOTE: this import was missing before
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ml_model = {}

STATIC_DIR = Path(__file__).parent / "static"

# Exact feature order the pipeline was trained on.
FEATURE_COLUMNS = [
    "person_age", "person_income", "person_home_ownership", "person_emp_length",
    "loan_intent", "loan_grade", "loan_amnt", "loan_int_rate",
    "loan_percent_income", "cb_person_default_on_file", "cb_person_cred_hist_length",
]

# A known-valid application used to self-test the explainer at startup.
SELF_TEST_ROW = pd.DataFrame([{
    "person_age": 35, "person_income": 62000.0, "person_home_ownership": "RENT",
    "person_emp_length": 4.5, "loan_intent": "EDUCATION", "loan_grade": "B",
    "loan_amnt": 12000.0, "loan_int_rate": 11.5, "loan_percent_income": 0.19,
    "cb_person_default_on_file": "N", "cb_person_cred_hist_length": 8,
}])[FEATURE_COLUMNS]


def _prepare_input(data: BaseModel) -> pd.DataFrame:
    return pd.DataFrame([data.dict()])[FEATURE_COLUMNS]


def _transform(prep, df: pd.DataFrame) -> np.ndarray:
    """Run the pipeline's preprocessing -> numeric, one-hot expanded matrix."""
    matrix = prep.transform(df)
    if hasattr(matrix, "toarray"):  # sparse output -> dense
        matrix = matrix.toarray()
    return np.asarray(matrix, dtype=np.float64)


def _positive_class_values(shap_values) -> np.ndarray:
    """Normalize shap_values output to a (rows, features) array for class 1."""
    values = shap_values
    if isinstance(values, list):
        values = values[-1] if len(values) == 1 else values[1]
    values = np.asarray(values)
    if values.ndim == 1:
        values = values.reshape(1, -1)
    if values.ndim == 3:  # (rows, features, classes)
        values = values[..., 1]
    return values


def _build_feature_map(transformed_names, original_columns):
    """Map each one-hot expanded column back to its original feature."""
    ordered = sorted(original_columns, key=len, reverse=True)
    mapping = []
    for name in transformed_names:
        match = next((orig for orig in ordered if orig in name), None)
        mapping.append(match if match is not None else name)
    return mapping


def _aggregate(values_row, mapping):
    """Sum the contributions of one-hot columns back onto original features."""
    totals = {}
    for contribution, original in zip(values_row, mapping):
        totals[original] = totals.get(original, 0.0) + float(contribution)
    return totals


def _fitted_pipelines(model):
    """Return the fitted Pipeline(s) that hold the XGBoost classifier(s).

    CalibratedClassifierCV keeps one fitted copy of the pipeline per CV fold in
    `calibrated_classifiers_`. A plain Pipeline is accepted too.
    """
    calibrated = getattr(model, "calibrated_classifiers_", None)
    if calibrated:
        pipelines = []
        for item in calibrated:
            inner = getattr(item, "estimator", None)  # scikit-learn >= 1.2
            if inner is None:
                inner = getattr(item, "base_estimator")  # older versions
            pipelines.append(inner)
        return pipelines
    return [model]


def _init_explainability():
    """Build one native TreeExplainer per fitted pipeline inside the saved model."""
    members = []
    for pipe in _fitted_pipelines(ml_model["model"]):
        steps = getattr(pipe, "steps", None)
        if not steps or len(steps) < 2:
            raise ValueError("expected Pipeline(preprocessing -> classifier)")
        prep, clf = pipe[:-1], steps[-1][1]

        # The numeric, one-hot expanded space the classifier actually saw in training.
        X_test = _transform(prep, SELF_TEST_ROW)

        try:
            names = [str(n) for n in prep.get_feature_names_out()]
        except Exception:
            names = []
        if len(names) != X_test.shape[1]:
            names = [f"feature_{i}" for i in range(X_test.shape[1])]
        feature_map = _build_feature_map(names, FEATURE_COLUMNS)

        explainer = shap.TreeExplainer(clf)  # raw (log-odds) space
        values = _positive_class_values(explainer.shap_values(X_test))
        if values.shape != X_test.shape:
            raise ValueError(f"unexpected shap_values shape {values.shape}")
        base = float(np.asarray(explainer.expected_value).ravel()[-1])

        # End-to-end check: base + sum(SHAP) must equal the pipeline's own
        # log-odds for the same row. Catches any mismatch in preprocessing.
        p = float(np.clip(pipe.predict_proba(SELF_TEST_ROW)[:, 1][0], 1e-12, 1 - 1e-12))
        if abs((base + float(values.sum())) - np.log(p / (1 - p))) > 1e-3:
            raise ValueError("SHAP values do not reconstruct the model output")

        members.append({"prep": prep, "explainer": explainer, "feature_map": feature_map})

    ml_model["members"] = members


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Model artifacts — original, unchanged.
    ml_model["model"] = joblib.load("credit_risk_model.pkl")
    ml_model["threshold"] = joblib.load("best_threshold.pkl")

    # SHAP: native TreeExplainer on the tree model(s) inside the pipeline.
    try:
        _init_explainability()
        print(f"[explain] TreeExplainer ready ({len(ml_model['members'])} fold model(s))")
    except Exception as exc:  # noqa: BLE001
        print(f"[explain] SHAP explainer unavailable: {exc}")
        ml_model["members"] = None

    yield
    ml_model.clear()


app = FastAPI(lifespan=lifespan)


# ------------------------------------------------------------------
# Model contract — original implementation, unchanged
# ------------------------------------------------------------------

class LoanApplication(BaseModel):
    person_age: int
    person_income: float
    person_home_ownership: str
    person_emp_length: float
    loan_intent: str
    loan_grade: str
    loan_amnt: float
    loan_int_rate: float
    loan_percent_income: float
    cb_person_default_on_file: str
    cb_person_cred_hist_length: int


@app.post("/predict")
def predict(data: LoanApplication):
    input_df = pd.DataFrame([data.dict()])

    probability = float(ml_model["model"].predict_proba(input_df)[:, 1][0])
    threshold = float(ml_model["threshold"])
    prediction = int(probability >= threshold)

    return {
        "default_probability": probability,
        "default_prediction": prediction,
        "threshold": threshold,
        "Result": "High Risk" if prediction == 1 else "Low Risk",
    }


# ------------------------------------------------------------------
# Explainability — per-applicant SHAP attributions
# ------------------------------------------------------------------

@app.post("/explain")
def explain(data: LoanApplication):
    """Why did /predict score this applicant the way it did?

    Contributions are in log-odds of default: positive pushes toward
    "High Risk", negative toward "Low Risk". Magnitudes are comparable
    between features of the same applicant.
    """
    members = ml_model.get("members")
    if not members:
        raise HTTPException(
            status_code=503,
            detail="Explainability is unavailable on this service "
                   "(the TreeExplainer could not be initialized).",
        )
    input_df = _prepare_input(data)
    try:
        per_member, bases = [], []
        for member in members:
            matrix = _transform(member["prep"], input_df)
            values = _positive_class_values(member["explainer"].shap_values(matrix))[0]
            per_member.append(_aggregate(values, member["feature_map"]))
            bases.append(float(np.asarray(member["explainer"].expected_value).ravel()[-1]))
        totals = {
            name: float(np.mean([m.get(name, 0.0) for m in per_member]))
            for name in FEATURE_COLUMNS
        }
        base_value = float(np.mean(bases))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Attribution computation failed: {exc}")

    raw = input_df.iloc[0]
    rows = [
        {
            "feature": name,
            "value": raw[name] if isinstance(raw[name], str) else float(raw[name]),
            "contribution": totals.get(name, 0.0),
        }
        for name in FEATURE_COLUMNS
    ]
    rows.sort(key=lambda row: abs(row["contribution"]), reverse=True)

    return {"shap_values": rows, "base_value": base_value, "output_space": "log_odds"}


# ------------------------------------------------------------------
# Frontend serving & health (additions — ML behaviour above untouched)
# ------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": bool(ml_model.get("model")),
        "explainability": bool(ml_model.get("members")),
    }


_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def serve_frontend():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)