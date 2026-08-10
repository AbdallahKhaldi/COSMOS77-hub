"""Series topology rail (playbook §1): parity split, shared out, exactly one closer."""

from __future__ import annotations

import pytest

from cosmos_hub import argvs, seeds
from cosmos_hub.runspec import RunSpec
from tests.conftest import make_settings

URLS = {"their_cop_url": "https://r.example/cop/mcp",
        "their_thief_url": "https://r.example/thief/mcp"}


def _spec(gid: str, kind: str = "f2", windows: int = 6) -> RunSpec:
    return RunSpec(kind=kind, opponent_gid=gid, windows=windows,
                   out_stamp=f"{kind}-test", **URLS)


def test_parity_from_gid_sort_ours_first(tmp_path):
    settings = make_settings(tmp_path)
    split = argvs.parity_windows(_spec("rival"), settings)  # cosmos77 < rival
    assert split == {"cop": "1,3,5", "thief": "2,4,6"}
    assert argvs.closer_role(_spec("rival"), settings) == "thief"  # owns window 6


def test_parity_from_gid_sort_ours_second_ascii_uppercase(tmp_path):
    settings = make_settings(tmp_path)
    for gid in ("SMNGRP05", "anrbj666", "best2934"):  # all sort before "cosmos77"
        split = argvs.parity_windows(_spec(gid), settings)
        assert split == {"cop": "2,4,6", "thief": "1,3,5"}, gid
        assert argvs.closer_role(_spec(gid), settings) == "cop"  # owns window 6


def test_run_argvs_complementary_spec_shared_out_single_closer(tmp_path):
    settings = make_settings(tmp_path)
    for gid, closer in (("rival", "thief"), ("SMNGRP05", "cop")):
        spec = _spec(gid)
        cop = argvs.run_argv("cop", spec, settings)
        thief = argvs.run_argv("thief", spec, settings)
        specs = {cop[cop.index("--windows-spec") + 1], thief[thief.index("--windows-spec") + 1]}
        assert specs == {"1,3,5", "2,4,6"}
        shared = str(settings.shared_runs_dir(spec.out_stamp))
        assert cop[cop.index("--out") + 1] == shared == thief[thief.index("--out") + 1]
        assert shared.startswith(str(settings.data_dir))  # ABSOLUTE, on the volume
        no_close = [r for r, argv in (("cop", cop), ("thief", thief)) if "--no-close" in argv]
        assert len(no_close) == 1 and closer not in no_close  # closer owns window 6


def test_counted_argvs_carry_the_same_topology_plus_arming(tmp_path):
    settings = make_settings(tmp_path)
    spec = RunSpec(kind="counted", opponent_gid="rival", windows=6,
                   out_stamp="counted-x", **URLS)
    cop = argvs.counted_argv("cop", spec, settings)
    thief = argvs.counted_argv("thief", spec, settings)
    assert cop[-1] == "--counted" and thief[-1] == "--counted"
    assert cop[cop.index("--windows-spec") + 1] == "1,3,5"
    assert thief[thief.index("--windows-spec") + 1] == "2,4,6"
    assert cop[cop.index("--out") + 1] == thief[thief.index("--out") + 1]
    assert ("--no-close" in cop) and ("--no-close" not in thief)


def test_f1_activates_only_the_window1_owner(tmp_path):
    settings = make_settings(tmp_path)
    assert argvs.active_roles(_spec("rival", kind="f1", windows=1), settings) == ("cop",)
    assert argvs.active_roles(_spec("SMNGRP05", kind="f1", windows=1), settings) == ("thief",)
    with pytest.raises(ValueError):  # the idle role must never be spawned with all windows
        argvs.run_argv("thief", _spec("rival", kind="f1", windows=1), settings)


def test_selfplay_keeps_alternate_labels_and_no_split(tmp_path):
    settings = make_settings(tmp_path)
    spec = RunSpec(kind="selfplay", opponent_gid="cosmos77-mirror", windows=6,
                   out_stamp="selfplay-x")
    assert argvs.active_roles(spec, settings) == ("cop", "thief")
    for role in ("cop", "thief"):
        argv = argvs.run_argv(role, spec, settings)
        assert "--alternate-labels" in argv
        assert "--windows-spec" not in argv and "--no-close" not in argv


def test_relay_parity_follows_the_gid_sort(tmp_path):
    settings = make_settings(tmp_path)
    default = argvs.relay_argv(settings)
    assert default[default.index("--odd-url") + 1].endswith(":8801/mcp")
    ours_first = argvs.relay_argv(settings, _spec("rival"))
    assert ours_first[ours_first.index("--odd-url") + 1].endswith(":8801/mcp")
    ours_second = argvs.relay_argv(settings, _spec("SMNGRP05"))
    assert ours_second[ours_second.index("--odd-url") + 1].endswith(":8802/mcp")
    assert ours_second[ours_second.index("--even-url") + 1].endswith(":8801/mcp")


def test_agents_declare_a_reachable_mcp_url_not_their_loopback_socket(tmp_path) -> None:
    """A counted opponent keeps our declaration; 127.0.0.1 would be true and useless."""
    settings = make_settings(tmp_path, public_url="https://arena.example")
    for role, path in (("cop", "/cop/mcp"), ("thief", "/thief/mcp")):
        env = seeds.spawn_env(role=role, public_url=settings.public_url)
        assert env["COSMOS_PUBLIC_MCP_URL"] == "https://arena.example" + path
    # the relay is not a declared agent endpoint, and no origin means no claim
    assert "COSMOS_PUBLIC_MCP_URL" not in seeds.spawn_env(role="relay", public_url="https://x")
    assert "COSMOS_PUBLIC_MCP_URL" not in seeds.spawn_env(role="cop", public_url="")
