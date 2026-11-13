import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clipping import jobctl, worker
from clipping.api import app
from clipping.db import Job, engine, init_db

init_db()
client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_queue():
    with Session(engine) as s:
        for j in s.exec(select(Job).where(Job.status.in_(["queued", "running"]))).all():
            j.status = "done"
            s.add(j)
        s.commit()
    worker.set_paused(False)
    yield
    worker.set_paused(False)


def _status(job_id):
    with Session(engine) as s:
        return s.get(Job, job_id).status


def test_order_move_and_cancel_queued():
    a, b, c = (worker.enqueue("nada_test", i).id for i in range(3))
    assert worker.queued_ids() == [a, b, c]
    assert client.post(f"/api/jobs/{c}/move", json={"to": "top"}).json()["order"] == [c, a, b]
    assert worker.move(a, "down") == [c, b, a]
    assert worker.move(c, "bottom") == [b, a, c]
    d = worker.enqueue("nada_test", 9).id  # lo nuevo va detrás aunque se haya reordenado
    assert worker.queued_ids() == [b, a, c, d]
    q = client.get("/api/jobs/queue").json()
    assert [r["id"] for r in q["queued"]] == [b, a, c, d] and q["paused"] is False
    assert client.post(f"/api/jobs/{a}/cancel").json() == {"status": "cancelled"}
    assert _status(a) == "cancelled" and a not in worker.queued_ids()
    assert client.post(f"/api/jobs/{a}/cancel").status_code == 400  # ya no está en cola
    assert client.post("/api/jobs/pause", json={"paused": True}).json() == {"paused": True}
    assert client.get("/api/jobs/queue").json()["paused"] is True


def test_running_job_is_killed_with_its_processes(monkeypatch):
    started = threading.Event()
    seen = {}

    def slow(ref_id):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        seen["proc"] = proc
        jobctl.track(proc)
        started.set()
        proc.wait()  # el proceso muere al parar
        jobctl.check()

    monkeypatch.setitem(worker.HANDLERS, "slow_test", (slow, Job))
    job = worker.enqueue("slow_test", 1)
    w = worker.Worker()
    w.start()
    try:
        assert started.wait(15)
        assert client.post(f"/api/jobs/{job.id}/cancel").json() == {"status": "stopping"}
        for _ in range(100):
            if _status(job.id) == "cancelled":
                break
            time.sleep(0.1)
        assert _status(job.id) == "cancelled"
        assert seen["proc"].poll() is not None  # el hijo ya no vive
        assert jobctl.current() is None
    finally:
        w.stop()
        w.join(5)
