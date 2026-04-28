#!/usr/bin/env python3
"""BioFlow UKB extract applet.

Runs inside the RAP Spark cluster. Inputs (declared in dxapp.json):
    fields_json   : file (JSON array of {fieldId, label?})
    rename_json   : file (JSON object mapping fieldId -> output column name)
    coding_values : string ("replace" | "raw")
    output_name   : string (e.g. "ukb_extracted_traits.tsv")

Output: a single TSV file uploaded as the `tsv` output.

The script uses dxdata to discover the dispensed UKB dataset, retrieve the
requested participant fields, optionally rename columns, and write a TSV.
Field IDs and rename labels are loaded from JSON inputs so user-supplied
values are never interpolated into source code.
"""
import json
import os
import pathlib
import subprocess
import sys


def read_string_input(name: str) -> str:
    """Read a string input value from the DNAnexus job environment.

    DNAnexus stages string inputs into the job's input JSON
    (~/job_input.json) and exposes them via dx-jobutil-parse-link or
    direct read. The simplest portable approach is to read job_input.json.
    """
    job_input_path = pathlib.Path(os.environ.get("HOME", ".")) / "job_input.json"
    if job_input_path.exists():
        try:
            payload = json.loads(job_input_path.read_text("utf-8"))
            value = payload.get(name)
            if isinstance(value, str):
                return value
        except Exception:
            pass
    return ""


def read_file_input_path(name: str) -> pathlib.Path:
    """File inputs are staged at $HOME/in/<name>/<original_filename>."""
    in_dir = pathlib.Path(os.environ.get("HOME", ".")) / "in" / name
    if not in_dir.is_dir():
        raise RuntimeError(f"Expected input directory {in_dir} does not exist")
    children = [child for child in in_dir.iterdir() if child.is_file()]
    if not children:
        raise RuntimeError(f"Input '{name}' did not stage any files into {in_dir}")
    return children[0]


def upload_output(local_path: pathlib.Path, output_name: str) -> None:
    """Upload `local_path` and register it as the `tsv` output."""
    result = subprocess.run(
        ["dx", "upload", str(local_path), "--brief"],
        capture_output=True,
        text=True,
        check=True,
    )
    file_id = result.stdout.strip().splitlines()[-1].strip()
    subprocess.run(
        ["dx-jobutil-add-output", output_name, file_id, "--class=file"],
        check=True,
    )


def main() -> int:
    import dxpy  # type: ignore
    import dxdata  # type: ignore
    import pyspark  # type: ignore

    fields_path = read_file_input_path("fields_json")
    rename_path = read_file_input_path("rename_json")
    coding_values = (read_string_input("coding_values") or "raw").strip()
    output_name = (read_string_input("output_name") or "ukb_extracted_traits.tsv").strip()

    field_rows = json.loads(fields_path.read_text("utf-8"))
    rename_map_raw = json.loads(rename_path.read_text("utf-8"))
    rename_map = {
        str(key): str(value)
        for key, value in (rename_map_raw or {}).items()
        if isinstance(value, str) and value.strip()
    }

    field_ids: list[str] = []
    for row in field_rows or []:
        if isinstance(row, dict):
            field_id = str(row.get("fieldId") or "").strip()
        else:
            field_id = str(row).strip()
        if field_id and field_id not in field_ids:
            field_ids.append(field_id)
    if not field_ids:
        raise RuntimeError("No UKB fields were supplied to the extraction applet.")

    sc = pyspark.SparkContext()
    spark = pyspark.sql.SparkSession(sc)  # noqa: F841 - required to bootstrap session

    dispensed_dataset_id = dxpy.find_one_data_object(
        typename="Dataset",
        name="app*.dataset",
        folder="/",
        name_mode="glob",
    )["id"]

    dataset = dxdata.load_dataset(id=dispensed_dataset_id)
    participant = dataset["participant"]

    coding_arg = "replace" if coding_values == "replace" else "raw"
    engine = dxdata.connect(dialect="hive+pyspark")
    df = participant.retrieve_fields(
        names=field_ids,
        coding_values=coding_arg,
        engine=engine,
    )

    final_columns: list[str] = []
    for field_id in field_ids:
        target = rename_map.get(field_id)
        if target and field_id in df.columns and target != field_id:
            df = df.withColumnRenamed(field_id, target)
        final_columns.append(target or field_id)

    output_path = pathlib.Path(output_name).name or "ukb_extracted_traits.tsv"
    spark_output_dir = pathlib.Path("_spark_output")
    df.select(*[col for col in final_columns if col in df.columns]).coalesce(1).write.option(
        "header", "true"
    ).option("sep", "\t").mode("overwrite").csv(str(spark_output_dir))

    # Spark writes part-*.csv inside the directory; rename to the requested name.
    parts = sorted(spark_output_dir.glob("part-*.csv"))
    if not parts:
        raise RuntimeError("Spark did not produce any output partitions for the extract.")
    final_path = pathlib.Path(output_path)
    parts[0].rename(final_path)

    upload_output(final_path, "tsv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
