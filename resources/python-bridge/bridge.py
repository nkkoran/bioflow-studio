#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import tempfile
from typing import Any, Dict

STATIC_INSTANCE_TYPES = [
    {"id": "mem1_ssd1_v2_x2", "name": "mem1_ssd1_v2_x2", "cpu": 2, "memoryGB": 16, "localSsdGB": 40},
    {"id": "mem1_ssd1_v2_x4", "name": "mem1_ssd1_v2_x4", "cpu": 4, "memoryGB": 32, "localSsdGB": 80},
    {"id": "mem1_ssd1_v2_x8", "name": "mem1_ssd1_v2_x8", "cpu": 8, "memoryGB": 64, "localSsdGB": 160},
    {"id": "mem1_ssd1_v2_x16", "name": "mem1_ssd1_v2_x16", "cpu": 16, "memoryGB": 128, "localSsdGB": 320},
]


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def error_response(request_id: str, error_type: str, message: str) -> None:
    emit({"id": request_id, "ok": False, "error": {"type": error_type, "message": message}})


def import_dxpy():
    try:
        import dxpy  # type: ignore
        return dxpy
    except Exception as exc:  # pragma: no cover - depends on local env
        raise RuntimeError(f"dxpy is unavailable: {exc}") from exc


def normalize_folder(path: str) -> str:
    if not path:
        return "/"
    return path if path.startswith("/") else f"/{path}"


def op_ping(_args: Dict[str, Any]) -> Dict[str, Any]:
    return {"pong": True}


def op_auth(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    token = args.get("token")
    project_id = args.get("projectId")
    if token:
        dxpy.set_security_context({"auth_token_type": "Bearer", "auth_token": token})
    if project_id:
        dxpy.set_workspace_id(project_id)
    return {"ok": True}


def op_list_projects(_args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    projects = []
    for project in dxpy.find_projects(level="VIEW"):
        desc = project.describe()
        projects.append({
            "id": project.get_id(),
            "name": desc.get("name", project.get_id()),
        })
    projects.sort(key=lambda item: item["name"].lower())
    return projects


def normalize_instance_specs(raw: Any) -> list[Dict[str, Any]]:
    candidates: list[tuple[str, Any]] = []
    if isinstance(raw, dict):
        for key, value in raw.items():
            candidates.append((str(key), value))
        results = raw.get("results")
        if isinstance(results, dict):
            for key, value in results.items():
                candidates.append((str(key), value))
    elif isinstance(raw, list):
        candidates = [(str(item.get("name") or item.get("id") or ""), item) for item in raw if isinstance(item, dict)]

    specs: list[Dict[str, Any]] = []
    seen = set()
    for key, value in candidates:
        if not isinstance(value, dict):
            continue
        name = str(value.get("name") or value.get("id") or key).strip()
        if not name or name in seen:
            continue
        cpu = value.get("numCores") or value.get("cpu") or value.get("vcpus") or value.get("cores")
        memory = value.get("totalMemoryGB") or value.get("memoryGB") or value.get("memory_gb")
        if memory is None:
            bytes_value = value.get("memoryBytes") or value.get("memory")
            if isinstance(bytes_value, (int, float)):
                memory = round(float(bytes_value) / (1024 ** 3))
        local_ssd = value.get("ephemeralStorageGB") or value.get("localSsdGB") or value.get("ssdGB")
        specs.append({
            "id": name,
            "name": name,
            "cpu": int(cpu or 0),
            "memoryGB": int(memory or 0),
            "localSsdGB": int(local_ssd or 0) or None,
        })
        seen.add(name)
    return [spec for spec in specs if spec["cpu"] > 0 and spec["memoryGB"] > 0]


def op_list_instance_types(_args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    raw = None
    try:
        if hasattr(dxpy.api, "system_describe_instance_types"):
            try:
                raw = dxpy.api.system_describe_instance_types({})
            except TypeError:
                raw = dxpy.api.system_describe_instance_types()
    except Exception:
        raw = None
    specs = normalize_instance_specs(raw) if raw is not None else []
    return specs or STATIC_INSTANCE_TYPES


def op_list_files(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    project_id = str(args["projectId"])
    folder = normalize_folder(str(args.get("path") or "/"))

    entries: list[Dict[str, Any]] = []

    # Folders come from project_list_folder; data objects come from find_data_objects.
    # find_data_objects only returns "data objects" (files etc) — folders are not
    # data objects on the platform and require a separate API call.
    try:
        folder_listing = dxpy.api.project_list_folder(
            project_id,
            {"folder": folder, "only": "folders", "describe": False},
        )
        for child in folder_listing.get("folders", []) or []:
            child_path = child if isinstance(child, str) else child.get("name") or ""
            if not child_path:
                continue
            name = child_path.rstrip("/").split("/")[-1]
            entries.append({
                "id": None,
                "projectId": project_id,
                "folder": folder,
                "name": name,
                "path": child_path,
                "isDirectory": True,
                "size": 0,
                "modified": 0,
                "permissions": "drwxr-xr-x",
                "extension": "",
            })
    except Exception:
        # Folder listing failures shouldn't kill the whole listing — files may
        # still be reachable via find_data_objects.
        pass

    for item in dxpy.bindings.search.find_data_objects(
        classname="file",
        project=project_id,
        folder=folder,
        recurse=False,
        describe=True,
    ):
        describe = item.get("describe", {})
        name = describe.get("name") or item.get("id") or ""
        full_path = describe.get("folder", folder)
        path = f"{full_path.rstrip('/')}/{name}".replace("//", "/") if name else full_path
        entries.append({
            "id": item.get("id"),
            "projectId": project_id,
            "folder": describe.get("folder", folder),
            "name": name,
            "path": path,
            "isDirectory": False,
            "size": int(describe.get("size", 0) or 0),
            "modified": int(describe.get("modified", 0) or 0),
            "permissions": "-rw-r--r--",
            "extension": pathlib.Path(name).suffix.lstrip(".").lower() if name else "",
        })
    entries.sort(key=lambda item: (not item["isDirectory"], item["name"].lower()))
    return entries


def op_stat(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    project_id = str(args["projectId"])
    raw_path = str(args["path"])
    folder = normalize_folder(os.path.dirname(raw_path) or "/")
    name = os.path.basename(raw_path)
    for item in dxpy.bindings.search.find_data_objects(
        classname="file",
        project=project_id,
        folder=folder,
        recurse=False,
        name=name,
        describe=True,
    ):
        describe = item.get("describe", {})
        return {
            "id": item.get("id"),
            "projectId": project_id,
            "folder": describe.get("folder", folder),
            "size": int(describe.get("size", 0) or 0),
            "modified": int(describe.get("modified", 0) or 0),
            "isDirectory": False,
            "permissions": "-rw-r--r--",
        }
    raise FileNotFoundError(raw_path)


def op_upload(request_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    project_id = str(args["projectId"])
    local_path = str(args["localPath"])
    folder = normalize_folder(str(args.get("folder") or "/"))
    total = os.path.getsize(local_path)
    emit({
        "id": request_id,
        "event": "progress",
        "data": {"direction": "upload", "bytes": 0, "total": total, "path": local_path, "project_id": project_id},
    })
    uploaded = dxpy.upload_local_file(
        local_path,
        project=project_id,
        folder=folder,
        parents=True,
    )
    emit({
        "id": request_id,
        "event": "progress",
        "data": {"direction": "upload", "bytes": total, "total": total, "path": local_path, "project_id": project_id, "file_id": uploaded.get_id()},
    })
    return {"fileId": uploaded.get_id()}


def op_download(request_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    file_id = str(args["fileId"])
    local_path = str(args["localPath"])
    os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
    emit({
        "id": request_id,
        "event": "progress",
        "data": {"direction": "download", "bytes": 0, "path": local_path, "file_id": file_id},
    })
    dxpy.download_dxfile(file_id, local_path)
    total = os.path.getsize(local_path)
    emit({
        "id": request_id,
        "event": "progress",
        "data": {"direction": "download", "bytes": total, "total": total, "path": local_path, "file_id": file_id},
    })
    return {"path": local_path}


def resolve_executable(dxpy, executable_ref: str):
    """Accept either a dxpy ID (applet-xxx / app-xxx), or an app/applet name.

    Plain strings such as "swiss-army-knife" must be looked up via
    find_one_app to resolve to a real handle.
    """
    ref = executable_ref.strip()
    if ref.startswith(("applet-", "app-")):
        return dxpy.get_handler(ref)
    # Try app first (published Apps), then applet (project-local).
    try:
        app = dxpy.find_one_app(name=ref, zero_ok=True)
        if app is not None:
            return dxpy.DXApp(dxid=app["id"])
    except Exception:
        pass
    found = dxpy.find_one_data_object(classname="applet", name=ref, zero_ok=True)
    if found is None:
        raise RuntimeError(f"Could not resolve DNAnexus executable '{executable_ref}'.")
    return dxpy.DXApplet(dxid=found["id"])


def op_run(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    applet_id = args.get("appletId")
    if not applet_id:
        raise RuntimeError("appletId is required for DNAnexus run requests")
    executable = resolve_executable(dxpy, str(applet_id))
    run_kwargs: Dict[str, Any] = {}
    if args.get("projectId"):
        run_kwargs["project"] = str(args["projectId"])
    if args.get("folder"):
        run_kwargs["folder"] = normalize_folder(str(args["folder"]))
    if args.get("name"):
        run_kwargs["name"] = str(args["name"])
    if args.get("instanceType"):
        run_kwargs["instance_type"] = str(args["instanceType"])
    launched = executable.run(args.get("inputs") or {}, **run_kwargs)
    return {"jobId": launched.get_id()}


def describe_one_job(dxpy, job_id: str) -> Dict[str, Any]:
    job = dxpy.DXJob(dxid=str(job_id))
    desc = job.describe()
    outputs = desc.get("output") or {}
    file_ids: list[str] = []
    for value in outputs.values():
        if isinstance(value, dict) and "$dnanexus_link" in value:
            file_ids.append(value["$dnanexus_link"])
    return {
        "jobId": job.get_id(),
        "state": desc.get("state", "unknown"),
        "name": desc.get("name"),
        "projectId": desc.get("project"),
        "startedAt": desc.get("startedRunning"),
        "finishedAt": desc.get("finishedRunning"),
        "fileIds": file_ids,
    }


def op_status(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    return describe_one_job(dxpy, str(args["jobId"]))


def op_status_batch(args: Dict[str, Any]) -> Dict[str, Any]:
    """Describe multiple jobs concurrently.

    `dxpy.find_jobs()` is not a batch-describe endpoint, so the only way to
    parallelise lookups is concurrent DXJob.describe() calls. We cap the
    pool at 8 to avoid hammering the platform when many array tasks fan out.
    """
    from concurrent.futures import ThreadPoolExecutor

    dxpy = import_dxpy()
    job_ids = [str(j) for j in (args.get("jobIds") or []) if j]
    if not job_ids:
        return []
    results: Dict[str, Any] = {}
    errors: Dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(job_ids))) as pool:
        future_map = {pool.submit(describe_one_job, dxpy, jid): jid for jid in job_ids}
        for future in future_map:
            jid = future_map[future]
            try:
                results[jid] = future.result()
            except Exception as exc:
                errors[jid] = str(exc)
    return {
        "results": [results[jid] for jid in job_ids if jid in results],
        "errors": [{"jobId": jid, "message": message} for jid, message in errors.items()],
    }


def op_cancel(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    job = dxpy.DXJob(dxid=str(args["jobId"]))
    job.terminate()
    return {"ok": True}


def applet_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1] / "dx-applets" / "ukb-extract"


def hash_directory(path: pathlib.Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    for child in sorted(path.rglob("*")):
        if child.is_dir():
            continue
        digest.update(child.relative_to(path).as_posix().encode("utf-8"))
        digest.update(child.read_bytes())
    return digest.hexdigest()


def current_token() -> str:
    dxpy = import_dxpy()
    context = dxpy.get_security_context() or {}
    token = context.get("auth_token")
    if not token:
        raise RuntimeError("DNAnexus auth token is not configured")
    return str(token)


def set_applet_hash(dxpy, applet_id: str, digest: str) -> None:
    applet = dxpy.DXApplet(dxid=applet_id)
    try:
        applet.set_properties({"bioflow_hash": digest})
    except Exception:
        try:
            dxpy.api.applet_set_properties(applet_id, {"project": None, "properties": {"bioflow_hash": digest}})
        except Exception:
            pass


def project_folder_exists(dxpy, project_id: str, folder: str) -> bool:
    try:
        dxpy.api.project_list_folder(project_id, {"folder": folder, "only": "folders"})
        return True
    except Exception:
        return False


def ensure_project_folder(dxpy, project_id: str, folder: str) -> None:
    folder = normalize_folder(folder)
    if folder == "/":
        return
    if project_folder_exists(dxpy, project_id, folder):
        return
    dxpy.api.project_new_folder(project_id, {"folder": folder, "parents": True})


def op_ensure_applet(request_id: str, args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    project_id = str(args["projectId"])
    root = applet_root()
    if not root.exists():
        raise FileNotFoundError(str(root))
    digest = hash_directory(root)
    destination = normalize_folder(str(args.get("folder") or "/BioFlow/applets"))
    emit({"id": request_id, "event": "status", "data": {"kind": "applet-install", "stage": "building", "percent": 10, "message": "Preparing UKB extract applet"}})
    name = str(args.get("appletName") or "bioflow-ukb-extract")
    for applet in dxpy.find_applets(name=name, project=project_id, describe=True):
        desc = applet.describe()
        properties = desc.get("properties") or {}
        if properties.get("bioflow_hash") == digest:
            emit({"id": request_id, "event": "status", "data": {"kind": "applet-install", "stage": "done", "percent": 100, "message": "Applet already installed"}})
            return {"appletId": applet.get_id(), "hash": digest}
    ensure_project_folder(dxpy, project_id, destination)
    emit({"id": request_id, "event": "status", "data": {"kind": "applet-install", "stage": "uploading", "percent": 55, "message": "Uploading applet bundle"}})
    env = {
        **os.environ,
        "DX_API_TOKEN": current_token(),
        "DX_PROJECT_CONTEXT_ID": project_id,
    }
    # Prefer the venv's `dx` so we don't depend on a system install.
    venv_dx = pathlib.Path(sys.prefix) / ("Scripts" if os.name == "nt" else "bin") / "dx"
    dx_executable = str(venv_dx) if venv_dx.exists() else "dx"
    command = [
        dx_executable,
        "build",
        str(root),
        "--force",
        "--destination",
        f"{project_id}:{destination}",
        "--brief",
    ]
    result = subprocess.run(command, capture_output=True, text=True, env=env, cwd=str(root))
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "dx build failed").strip())
    applet_id = (result.stdout or "").strip().splitlines()[-1].strip()
    if not applet_id:
        raise RuntimeError("dx build did not return an applet id")
    emit({"id": request_id, "event": "status", "data": {"kind": "applet-install", "stage": "verifying", "percent": 90, "message": "Recording applet metadata"}})
    set_applet_hash(dxpy, applet_id, digest)
    emit({"id": request_id, "event": "status", "data": {"kind": "applet-install", "stage": "done", "percent": 100, "message": "Applet ready"}})
    return {"appletId": applet_id, "hash": digest}


def op_spark_extract(args: Dict[str, Any]) -> Dict[str, Any]:
    dxpy = import_dxpy()
    applet_id = str(args.get("appletId") or "").strip()
    project_id = str(args.get("projectId") or "").strip()
    if not applet_id:
        raise RuntimeError("APPLET_NOT_INSTALLED")
    if not project_id:
        raise RuntimeError("projectId is required for spark extraction")

    folder = normalize_folder(str(args.get("folder") or "/BioFlow/extract-inputs"))
    ensure_project_folder(dxpy, project_id, folder)

    with tempfile.TemporaryDirectory(prefix="bioflow-ukb-") as tmpdir:
        fields_path = pathlib.Path(tmpdir) / "fields.json"
        rename_path = pathlib.Path(tmpdir) / "rename.json"
        fields_path.write_text(json.dumps(args.get("fields") or [], indent=2), encoding="utf-8")
        rename_path.write_text(json.dumps(args.get("renameMap") or {}, indent=2), encoding="utf-8")

        fields_file = dxpy.upload_local_file(str(fields_path), project=project_id, folder=folder, parents=True)
        rename_file = dxpy.upload_local_file(str(rename_path), project=project_id, folder=folder, parents=True)

    executable = resolve_executable(dxpy, applet_id)
    run_kwargs: Dict[str, Any] = {"project": project_id}
    if args.get("outputFolder"):
        run_kwargs["folder"] = normalize_folder(str(args["outputFolder"]))
    if args.get("instanceType"):
        run_kwargs["instance_type"] = str(args["instanceType"])
    job = executable.run({
        "fields_json": {"$dnanexus_link": fields_file.get_id()},
        "rename_json": {"$dnanexus_link": rename_file.get_id()},
        "coding_values": str(args.get("codingValues") or "raw"),
        "output_name": str(args.get("outputName") or "ukb_extract.tsv"),
    }, **run_kwargs)
    return {"jobId": job.get_id()}


OPERATIONS = {
    "ping": op_ping,
    "auth": op_auth,
    "list_projects": op_list_projects,
    "list_instance_types": op_list_instance_types,
    "list_files": op_list_files,
    "stat": op_stat,
    "run": op_run,
    "status": op_status,
    "cancel": op_cancel,
    "status_batch": op_status_batch,
    "spark_extract": op_spark_extract,
}


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request: Dict[str, Any] = {}
        try:
            request = json.loads(line)
            request_id = str(request.get("id"))
            op = str(request.get("op"))
            args = request.get("args") or {}
            if op == "upload":
                result = op_upload(request_id, args)
            elif op == "download":
                result = op_download(request_id, args)
            elif op == "ensure_applet":
                result = op_ensure_applet(request_id, args)
            else:
                handler = OPERATIONS.get(op)
                if handler is None:
                    raise RuntimeError(f"Unknown bridge op: {op}")
                result = handler(args)
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            error_response(str(request.get("id", "unknown")), exc.__class__.__name__, str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
