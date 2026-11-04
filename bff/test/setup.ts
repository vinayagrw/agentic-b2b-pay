import { beforeEach } from "vitest";
import { installFakes } from "./fakeRail.js";
// Model-free and network-free by default. The sandbox contract file swaps the real adapters back in.
beforeEach(() => { installFakes(); });
