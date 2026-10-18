"""Run from the project folder:  python test_explain.py
Starts the app in-process and checks /health, /predict and /explain."""
from fastapi.testclient import TestClient
import main

APP = {
    "person_age": 35, "person_income": 62000, "person_home_ownership": "RENT",
    "person_emp_length": 4.5, "loan_intent": "EDUCATION", "loan_grade": "B",
    "loan_amnt": 12000, "loan_int_rate": 11.5, "loan_percent_income": 0.19,
    "cb_person_default_on_file": "N", "cb_person_cred_hist_length": 8,
}

with TestClient(main.app) as client:        # `with` runs the startup (model load + SHAP init)
    print("health :", client.get("/health").json())
    print("predict:", client.post("/predict", json=APP).json())
    r = client.post("/explain", json=APP)
    print("explain:", r.status_code)
    body = r.json()
    assert r.status_code == 200, body
    assert len(body["shap_values"]) == 11
    for row in body["shap_values"]:
        print(f'  {row["feature"]:<28} {row["value"]!s:<10} {row["contribution"]:+.4f}')
    print("base_value (log-odds):", body["base_value"])
    print("ALL OK")