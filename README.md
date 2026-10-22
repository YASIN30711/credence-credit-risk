<div align="center">

<img src="static/logo-mark.png" alt="Credence logo" width="84">

# Credence

**Explainable credit-risk assessment — from a Jupyter notebook to a deployed web application.**

[![Live demo](https://img.shields.io/badge/live%20demo-credence--8yj4.onrender.com-1C1A15?style=flat-square)](https://credence-8yj4.onrender.com)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![XGBoost](https://img.shields.io/badge/XGBoost-calibrated-1C1A15?style=flat-square)
![SHAP](https://img.shields.io/badge/SHAP-TreeExplainer-B3362B?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-256D46?style=flat-square)

[**Open the live demo →**](https://credence-8yj4.onrender.com) &nbsp;·&nbsp; [日本語の概要](#日本語の概要) &nbsp;·&nbsp; [Limitations](#limitations-and-honest-notes)

</div>

> **Heads-up:** the demo runs on a free hosting tier that sleeps when idle. If the page shows a loading screen, wait about a minute — it is waking up, not broken.

---

## What this project is

Credence takes an applicant's loan profile (11 inputs), returns a **probability of default**, turns it into a **High Risk / Low Risk** decision using a tuned threshold, and then answers the question a bare model cannot: ***why?***

Every assessment is explained live with **SHAP**, and the explanation is explored on a dedicated page with four views — a signed bar chart, a donut of influence share, a waterfall from the base rate to the final score, and a side-by-side comparison of up to five what-if scenarios.

I built it to practise the whole path that a machine-learning idea has to travel before anyone can use it: data cleaning → modelling → honest evaluation → calibration → explainability → an API → a usable interface → deployment.

| Webpage | Everything About the Model | Menu |
|---|---|---|
| ![Webpage](Screenshot%202026-10-22%20220318.png) | ![Everything About the Model](Screenshot%202026-10-22%20220531.png) | ![Menu](Screenshot%202026-10-22%20220540.png) |
## Assessment Screenshots

| Applicant Profile | Loan Request | Credit History |
|:---:|:---:|:---:|
| ![Applicant Profile](Screenshot%202026-10-22%20225741.png) | ![Loan Request](Screenshot%202026-10-22%20225749.png) | ![Credit History](Screenshot%202026-10-22%20225754.png) |
| **Applicant Details** | **Loan Information** | **Credit History** |

| Risk Outcome | Outcome Details |
|:---:|:---:|
| ![Risk Outcome](Screenshot%202026-10-22%20225804.png) | ![Outcome Details](Screenshot%202026-10-22%20225810.png) |
| **Risk Prediction** | **Detailed Results** |
## Model Attribution

| Feature Attribution | Bar Chart | Pie Chart | Waterfall | Compare |
|:---:|:---:|:---:|:---:|:---:|
| ![Feature Attribution](Screenshot%202026-10-22%20220739.png) | ![Bar Chart](Screenshot%202026-10-22%20231116.png) | ![Pie Chart](Screenshot%202026-10-22%20220748.png) | ![Waterfall](Screenshot%202026-10-22%20231128.png) | ![Compare](Screenshot%202026-10-22%20231323.png) |
## Features

| | |
|---|---|
| **Risk assessment** | 11-field form with validation, live loan-to-income ratio, and 7 display currencies (converted to USD before scoring, because the model was trained on USD-scale amounts). |
| **Calibrated probabilities** | The model's raw scores were sigmoid-calibrated so that "30%" is meant to behave like a 30% chance, not just a ranking. |
| **Per-applicant SHAP** | `POST /explain` returns signed contributions in log-odds for each of the 11 original features, averaged over the five boosters inside the calibrated ensemble. |
| **Attribution page** | Bar · Donut · Waterfall · Compare, with Top-5 / Top-8 / All filtering, log-odds ↔ % switch, hover tooltips, keyboard access and a "view as table" fallback. |
| **Scenario comparison** | Change an input, re-score, and see exactly which factors moved the risk — useful for sensitivity ("what if the loan were smaller?"). |
| **Self-checking explainer** | On startup the API verifies that `base value + Σ SHAP` reproduces the model's own log-odds for a known row, and refuses to serve explanations if it does not. |

## How it works

![How FastAPI Powers Risk Attribution](How%20FastAPI%20Powers%20Risk%20Attribution.png)
- **Backend:** FastAPI serves three endpoints and the static front end from one process.
- **Front end:** plain HTML, CSS and JavaScript — no framework, no build step. Charts are hand-built SVG/DOM.
- **Deployment:** a free web service on Render, described in [`render.yaml`](render.yaml).

## The machine-learning work

The full workflow is in [`Credit_Risk.ipynb`](Credit_Risk.ipynb).

**Data.** A public credit-risk dataset: 32,581 loans, 11 input features, binary target `loan_status` (1 = default). Roughly 22 % of loans default, so the classes are imbalanced.

**Cleaning.** Removed 165 duplicate rows, ages outside 18–100, and employment lengths above 60 years (the raw data contains impossible values such as a 123-year employment history) → **31,522 rows**. Missing values (`person_emp_length`: 895, `loan_int_rate`: 3,116) are median-imputed inside the pipeline; missing categories get an explicit `"Missing"` level.

**Split.** 80 / 20 stratified split (`random_state=42`): 25,217 train / 6,305 test, with the same default rate in both.

**Models.** Everything is a scikit-learn `Pipeline` (impute → scale/encode → classifier) so preprocessing is fitted only on training folds — no leakage from the transformers.

| Model | Imbalance handling |
|---|---|
| Logistic Regression (baseline) | `class_weight="balanced"` |
| XGBoost | `scale_pos_weight = 3.63` (negatives ÷ positives) |

**Results.**

| 5-fold stratified CV, training split (mean) | ROC-AUC | Accuracy | Precision | Recall | F1 |
|---|---|---|---|---|---|
| Logistic Regression | 0.871 | 0.812 | 0.545 | 0.778 | 0.641 |
| **XGBoost** | **0.947** | **0.918** | **0.819** | **0.796** | **0.807** |

| Hold-out test set (6,305 loans) — untuned XGBoost, default 0.5 cut-off | Precision | Recall | F1 |
|---|---|---|---|
| Default class (1) | 0.82 | 0.79 | 0.81 |

Confusion matrix on the hold-out set: 4,711 true negatives · 232 false positives · 281 false negatives · 1,081 true positives.

**Tuning.** `RandomizedSearchCV` — 150 candidates × 5 folds = 750 fits, optimising average precision. Best: `n_estimators=565`, `max_depth=6`, `learning_rate≈0.127`, `subsample≈0.97`, `colsample_bytree≈0.86`, `gamma≈0.82`, `min_child_weight=7`.

**Calibration.** So that predicted probabilities behave like real frequencies, the tuned model is wrapped in `CalibratedClassifierCV(method="sigmoid", cv=5)` (Platt scaling), and reliability curves were compared before and after. The decision threshold (**0.3935**) is the F1-maximising cut-off on the calibrated scale — see the first limitation below for how that was chosen.

## Explainability

SHAP values are computed with XGBoost's native `TreeExplainer` in **log-odds space**, where contributions add up exactly:

```
model output (log-odds) = base value + Σ contributions
```

Because the saved model is a calibrated ensemble of five boosters, `/explain` explains each booster, folds the one-hot-expanded columns back onto the 11 original inputs, and averages. Positive values push toward default; negative values pull away.

Reading the attribution page:

- **Bar** — signed contribution per feature, diverging from zero.
- **Donut** — each feature's share of total absolute influence; red raises risk, green lowers it.
- **Waterfall** — starts at the base rate and adds one feature at a time until it reaches the model output.
- **Compare** — up to five scenarios side by side, or the *change versus Scenario A*.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/predict` | Probability of default, threshold and High/Low Risk decision |
| `POST` | `/explain` | Signed SHAP contributions (log-odds) for each of the 11 features |
| `GET` | `/health` | Model and explainer status |

```bash
curl -X POST https://credence-8yj4.onrender.com/predict \
  -H "Content-Type: application/json" \
  -d '{
    "person_age": 35, "person_income": 62000, "person_home_ownership": "RENT",
    "person_emp_length": 4.5, "loan_intent": "EDUCATION", "loan_grade": "B",
    "loan_amnt": 12000, "loan_int_rate": 11.5, "loan_percent_income": 0.19,
    "cb_person_default_on_file": "N", "cb_person_cred_hist_length": 8
  }'
```

The response contains `default_probability`, `default_prediction`, `threshold` and `Result`. Interactive API docs are served at `/docs`.

## Run it locally

```bash
git clone https://github.com/YASIN30711/credence-credit-risk.git
cd credence-credit-risk

python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

uvicorn main:app --reload
# open http://127.0.0.1:8000
```

Smoke test (starts the app in-process and checks `/health`, `/predict` and `/explain`):

```bash
python test_explain.py
```

## Project structure

```
├── main.py                  FastAPI app: /predict, /explain, /health, serves the UI
├── credit_risk_model.pkl    Calibrated XGBoost ensemble (joblib)
├── best_threshold.pkl       Decision threshold (joblib)
├── credit_risk_dataset.csv  Training data
├── Credit_Risk.ipynb        EDA, modelling, tuning, calibration, SHAP
├── test_explain.py          Smoke test for the API
├── render.yaml              Deployment blueprint
├── requirements.txt
└── static/
    ├── index.html · styles.css · app.js            Assessment interface
    └── attribution.html · .css · .js               Attribution page
```

## Limitations and honest notes

A model like this is easy to over-sell. These are the things I would want a reader to know:

1. **The deployed model has no clean test score yet.** In the notebook, `CalibratedClassifierCV(cv=5)` was fitted on the 20 % hold-out split, and the decision threshold was also chosen on it. That means the five boosters in the deployed ensemble were refit on folds of the hold-out data, and no untouched data remains to score the final system. The cross-validation numbers above (from training data only) and the hold-out numbers for the *untuned* model are leak-free, but they describe the model *before* tuning and calibration. **Fixing the protocol is the first item on the roadmap below.**
2. **The calibration check is optimistic** for the same reason: the before/after reliability curves were drawn on the data the calibrator saw.
3. **Some inputs are the lender's own judgement.** `loan_grade` and `loan_int_rate` are assigned by the lender after assessing risk, and SHAP shows `loan_grade` as the dominant driver. That is fine for studying the dataset, but it would be circular for a new applicant who has no grade yet.
4. **`person_age` is a model input.** Using age in real credit decisions raises fairness and legal questions in many jurisdictions. This project does not include a fairness audit.
5. **Public data, not a real lender's.** Results say nothing about how this model would behave on a real portfolio.
6. **Decision support, not underwriting.** Credence quantifies statistical risk. It must not be used to approve or decline real loans.
7. **Library versions matter.** The model was serialised with specific scikit-learn / XGBoost versions; loading it under others can warn or silently change behaviour. `requirements.txt` pins scikit-learn exactly; XGBoost is only range-pinned (`>=2.1,<3`), so pinning it exactly is on the roadmap.

## Roadmap

- [ ] **Rebuild the evaluation protocol:** tune, calibrate and choose the threshold using only training data (nested or cross-validated), then evaluate once on an untouched test set; report ROC-AUC, PR-AUC, Brier score and a reliability diagram.
- [ ] Re-train without `loan_grade` / `loan_int_rate` and compare — how much predictive power comes from the lender's own assessment?
- [ ] Fairness audit across age groups (equalised odds, calibration within groups).
- [ ] Monotonic constraints on features where direction is known (e.g. higher loan-to-income should never lower risk).
- [ ] Pin XGBoost to the exact training version; add CI that runs `test_explain.py`.
- [ ] Containerise with Docker.

## 日本語の概要

**Credence（クレデンス）** は、ローン申請者の情報（11項目）から**債務不履行（デフォルト）確率**を予測し、「高リスク／低リスク」を判定する、説明可能な信用リスク評価Webアプリケーションです。

- **モデル：** 勾配ブースティング（XGBoost）を5分割交差検証とランダムサーチ（150候補）で調整し、確率較正（シグモイド）を適用しました。5分割交差検証での ROC-AUC は 0.947 です。
- **説明可能性：** SHAP（TreeExplainer）により、各申請者について「どの要因がリスクを上げ、どの要因が下げたか」を対数オッズで算出します。専用ページで、棒グラフ・ドーナツ・ウォーターフォール・シナリオ比較の4種類で可視化できます。
- **実装：** FastAPI（バックエンド）、フレームワークを使わない HTML/CSS/JavaScript（フロントエンド）、Render へのデプロイまでを一貫して実装しました。
- **誠実な注記：** 最終モデルの較正としきい値の選択にテストデータを使っているため、完全に独立した最終評価はまだできていません。評価手順の再設計を最優先の課題としています（上記 Limitations 参照）。また、本ツールは意思決定の補助であり、実際の融資判断に用いるものではありません。

## Acknowledgements

Built with [FastAPI](https://fastapi.tiangolo.com/), [XGBoost](https://xgboost.readthedocs.io/), [scikit-learn](https://scikit-learn.org/) and [SHAP](https://shap.readthedocs.io/). The dataset is a public credit-risk dataset from Kaggle.

## License

[MIT](LICENSE) © Yasin
