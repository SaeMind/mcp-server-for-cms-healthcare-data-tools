/**
 * Exports all four DEMO_MODE datasets to CSV for Tableau ingestion.
 * Run: npx ts-node --esm scripts/export_demo_csv.ts
 * Or:  npx tsx scripts/export_demo_csv.ts
 */

import fs from "fs";
import path from "path";

// ── inline the sample data so this script has no import deps on datasources ──

const HCC_ROWS = [
  ["icdCode","icdDescription","hccCategory","hccDescription","relativeFactorDual","relativeFactorNondual","modelYear","hierarchyGroup"],
  ["E11.9","Type 2 diabetes mellitus without complications",19,"Diabetes without Complication",0.302,0.302,2024,"Diabetes"],
  ["E11.65","Type 2 diabetes mellitus with hyperglycemia",19,"Diabetes without Complication",0.302,0.302,2024,"Diabetes"],
  ["E11.40","Type 2 diabetes mellitus with diabetic neuropathy, unspecified",18,"Diabetes with Chronic Complications",0.320,0.318,2024,"Diabetes"],
  ["I50.9","Heart failure, unspecified",85,"Congestive Heart Failure",0.323,0.331,2024,"Cardiovascular"],
  ["I50.22","Chronic systolic heart failure",85,"Congestive Heart Failure",0.323,0.331,2024,"Cardiovascular"],
  ["J44.1","Chronic obstructive pulmonary disease with acute exacerbation",111,"Chronic Obstructive Pulmonary Disease",0.335,0.335,2024,"Pulmonary"],
  ["N18.4","Chronic kidney disease, stage 4",138,"Chronic Kidney Disease, Stage 4",0.289,0.289,2024,"Renal"],
  ["C34.90","Malignant neoplasm of unspecified part of unspecified bronchus or lung",9,"Lung and Other Severe Cancers",1.023,1.023,2024,"Cancer"],
  ["G35","Multiple sclerosis",77,"Multiple Sclerosis",0.421,0.421,2024,"Neurological"],
  ["I21.9","Acute myocardial infarction, unspecified",86,"Acute Myocardial Infarction",0.278,0.278,2024,"Cardiovascular"],
];

const READMISSION_ROWS = [
  ["hospitalCcn","hospitalName","state","measureId","measureName","denominator","numerator","readmissionRate","nationalRate","performanceCategory","reportingPeriod"],
  ["450289","Memorial Hermann Hospital","TX","READM-30-AMI","30-Day AMI Readmission Rate",423,58,0.137,0.152,"better","2022-07-01/2023-06-30"],
  ["450289","Memorial Hermann Hospital","TX","READM-30-HF","30-Day Heart Failure Readmission Rate",892,192,0.215,0.221,"same","2022-07-01/2023-06-30"],
  ["330101","NewYork-Presbyterian Hospital","NY","READM-30-COPD","30-Day COPD Readmission Rate",1204,238,0.198,0.204,"same","2022-07-01/2023-06-30"],
  ["050376","Cedars-Sinai Medical Center","CA","READM-30-AMI","30-Day AMI Readmission Rate",567,72,0.127,0.152,"better","2022-07-01/2023-06-30"],
  ["230038","University of Michigan Health","MI","READM-30-PN","30-Day Pneumonia Readmission Rate",789,142,0.18,0.172,"worse","2022-07-01/2023-06-30"],
];

const MIPS_ROWS = [
  ["npi","providerName","specialty","measureId","measureName","measureCategory","denominator","numerator","performanceRate","reportingYear","measureType"],
  ["1234567890","Smith, John A","Internal Medicine","001","Diabetes: Hemoglobin A1c (HbA1c) Poor Control (>9%)","Diabetes",145,22,0.152,2023,"outcome"],
  ["1234567890","Smith, John A","Internal Medicine","236","Controlling High Blood Pressure","Cardiovascular",312,267,0.856,2023,"process"],
  ["9876543210","Johnson, Maria L","Cardiology","005","Heart Failure: ACE Inhibitor or ARB Therapy","Heart Failure",203,197,0.97,2023,"process"],
  ["5551234567","Patel, Priya R","Pulmonology","052","Chronic Obstructive Pulmonary Disease: Inhaled Bronchodilator Therapy","Pulmonary",88,83,0.943,2023,"process"],
];

const PARTD_ROWS = [
  ["drugName","genericName","brandName","drugClass","totalClaims","totalBeneficiaries","totalDayCoverage","totalDrugCost","avgCostPerClaim","avgCostPerDay","reportingYear","state"],
  ["Metformin HCl","metformin hydrochloride","Glucophage","Biguanides (Antidiabetics)",89234,67812,8921340,4123450.0,46.21,0.46,2022,"TX"],
  ["Lisinopril","lisinopril","Prinivil/Zestril","ACE Inhibitors (Antihypertensives)",112456,89234,11245600,5234780.0,46.54,0.47,2022,"TX"],
  ["Atorvastatin Calcium","atorvastatin calcium","Lipitor","Statins (Lipid-Lowering)",145678,112345,14567800,8923450.0,61.26,0.61,2022,"CA"],
  ["Empagliflozin","empagliflozin","Jardiance","SGLT2 Inhibitors (Antidiabetics)",23456,18234,2345600,85234560.0,3635.12,36.35,2022,"TX"],
  ["Semaglutide","semaglutide","Ozempic","GLP-1 Agonists (Antidiabetics)",45678,34512,4567800,234560000.0,5135.12,51.35,2022,"CA"],
];

function toCSV(rows: (string | number)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          typeof cell === "string" && (cell.includes(",") || cell.includes('"'))
            ? `"${cell.replace(/"/g, '""')}"`
            : String(cell)
        )
        .join(",")
    )
    .join("\n");
}

const outDir = path.join(process.cwd(), "outputs");
fs.mkdirSync(outDir, { recursive: true });

const datasets: { name: string; rows: (string | number)[][] }[] = [
  { name: "hcc_risk_adjustment", rows: HCC_ROWS },
  { name: "hospital_readmission", rows: READMISSION_ROWS },
  { name: "mips_quality_measures", rows: MIPS_ROWS },
  { name: "partd_drug_utilization", rows: PARTD_ROWS },
];

for (const ds of datasets) {
  const filePath = path.join(outDir, `${ds.name}_demo.csv`);
  fs.writeFileSync(filePath, toCSV(ds.rows), "utf8");
  console.log(`Wrote ${filePath} (${ds.rows.length - 1} data rows)`);
}

console.log("\nAll CSVs written to outputs/. Load into Tableau Public for dashboard build.");
console.log("NOTE: These are DEMO_MODE=true embedded sample records, not live CMS data.");
