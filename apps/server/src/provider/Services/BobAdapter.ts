/**
 * BobAdapter — shape type for the IBM Bob provider adapter.
 *
 * Like {@link ./ClaudeAdapter}, the driver model bundles one adapter per
 * instance as a captured closure, so there is no `Context.Service` tag here —
 * only the shape interface, used as a naming anchor for the driver bundle.
 *
 * @module BobAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * BobAdapterShape — per-instance Bob adapter contract.
 */
export interface BobAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
