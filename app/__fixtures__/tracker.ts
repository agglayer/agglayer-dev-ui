import type { AggkitTrackingData } from '@agglayer/sdk';

// Trimmed local copies of the aggkit tracker fixtures captured against the
// devnet enclave (see sdk/src/aggkit/__fixtures__/tracker_*.json in the
// sibling SDK repo) -- kept here so dev-ui's own unit tests (S9) don't reach
// across repos. Field values are the real captured ones; only comments/
// whitespace differ from the source JSON.

// tracking_status 'registered': all_steps still null, tracker hasn't
// resolved the route yet.
export const registeredFixture: AggkitTrackingData = {
  tracking_status: 'registered',
  network_id: 1,
  tx_hash: '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
  bridge_status: null,
  step_index: null,
  all_steps: null,
  error: {
    error_type: 0,
    error_type_string: 'transient',
    retry_count: 1,
    description: [
      'network=1/tx=0xdeadbeef00000000000000000000000000000000000000000000000000000000 does not exist on the network'
    ]
  }
};

// L1->L2 mid-flight: 4 steps, step_index 2 (WaitingClaim) inProgress.
export const l1l2RunningFixture: AggkitTrackingData = {
  tracking_status: 'running',
  network_id: 0,
  tx_hash: '0x64b65138996aae61811dac45f10c2baddbf0ab5aae9ef587766b92a23c85791e',
  bridge_status: {
    bridge_type: 'L1->L2',
    block_number: 519,
    log_index: 0,
    block_timestamp: 1786113909,
    event: {
      leaf_type: 'Asset',
      origin_network: 0,
      origin_address: '0x0000000000000000000000000000000000000000',
      destination_network: 1,
      destination_address: '0xa0b4b0c6314b6b028adf7c787eca150add9e1ec0',
      amount: '1000000000000000000',
      deposit_count: 3
    }
  },
  step_index: 2,
  all_steps: [
    {
      step_index: 0,
      step_name: 'WaitingGERUpdate',
      status: 'done',
      start_date: '2026-08-07T14:45:14.940426998Z',
      end_date: '2026-08-07T14:45:14.942687479Z',
      result: {
        l1_info_tree_index: 6,
        ger: '0x6c670cb382e5202b19eae5ae3d61491f38c5d4806a4d154410d5370816fbf090',
        mer: '0xaa7f2b3bcb3d6303a1af1d4b4322d197db525e63e4472ef50c352b316de9598b',
        rer: '0x226608c15eee1d684ad841ee83dc549bc9c3f25ccff4a102d8065aeb90bc6c1c',
        block_number: 519,
        block_timestamp: 1786113909,
        log_index: 2
      }
    },
    {
      step_index: 1,
      step_name: 'WaitingGERInjection',
      status: 'done',
      start_date: '2026-08-07T14:45:14.942687479Z',
      end_date: '2026-08-07T14:45:56.844525693Z',
      result: { ger: '0x6c670cb382e5202b19eae5ae3d61491f38c5d4806a4d154410d5370816fbf090' }
    },
    {
      step_index: 2,
      step_name: 'WaitingClaim',
      status: 'inProgress',
      start_date: '2026-08-07T14:45:56.844525693Z'
    },
    {
      step_index: 3,
      step_name: 'Claimed',
      status: 'pending'
    }
  ],
  error: null
};

// L1->L2 finished: same route, all 4 steps done (terminal).
export const l1l2FinishedFixture: AggkitTrackingData = {
  ...l1l2RunningFixture,
  tracking_status: 'finished',
  step_index: 3,
  all_steps: [
    l1l2RunningFixture.all_steps![0],
    l1l2RunningFixture.all_steps![1],
    {
      step_index: 2,
      step_name: 'WaitingClaim',
      status: 'done',
      start_date: '2026-08-07T14:45:56.844525693Z',
      end_date: '2026-08-07T14:46:06.844712083Z',
      result: {
        claim_tx: '0x178eed25e7a70d088367b81879bffb7fa800e3f23789d8a11bd05ae78505e3f3',
        block_number: 909
      }
    },
    {
      step_index: 3,
      step_name: 'Claimed',
      status: 'done',
      start_date: '2026-08-07T14:46:06.844712083Z',
      end_date: '2026-08-07T14:46:06.844712083Z'
    }
  ]
};

// L2->L1 finished: 6 steps, all done -- carries a certificate id
// (PendingInclusion/CertificatePending) and a claim tx (WaitingClaim), used
// to assert the modal detail renders both result shapes.
export const l2l1FinishedFixture: AggkitTrackingData = {
  tracking_status: 'finished',
  network_id: 1,
  tx_hash: '0xcfbdc931acce665da204150bc025cd76cdbe5566578abaa1ec4ef236fa5c8009',
  bridge_status: {
    bridge_type: 'L2->L1',
    block_number: 826,
    log_index: 0,
    block_timestamp: 1786113875,
    event: {
      leaf_type: 'Asset',
      origin_network: 0,
      origin_address: '0x0000000000000000000000000000000000000000',
      destination_network: 0,
      destination_address: '0xa0b4b0c6314b6b028adf7c787eca150add9e1ec0',
      amount: '50000000000000000',
      deposit_count: 1
    }
  },
  step_index: 5,
  all_steps: [
    {
      step_index: 0,
      step_name: 'WaitingLERUpdate',
      status: 'done',
      start_date: '2026-08-07T14:44:45.774402045Z',
      end_date: '2026-08-07T14:44:45.776405692Z',
      result: {
        network_id: 1,
        ler: '0x3ba1af1eba0fbefdbd0b741efc3d805119a3b192663784bf8974f7dc27d3f41e',
        block_number: 826
      }
    },
    {
      step_index: 1,
      step_name: 'PendingInclusion',
      status: 'done',
      start_date: '2026-08-07T14:44:45.776405692Z',
      end_date: '2026-08-07T14:44:45.776405692Z',
      result: {
        certificate_id: '0xfd92b4854c0364e0a9e8e3bade6bbcc0873a6be917321320d7e2f24e24f7131f',
        new_ler: '0x3ba1af1eba0fbefdbd0b741efc3d805119a3b192663784bf8974f7dc27d3f41e',
        previous_ler: '0xfd107fe3ba1c4de7139e4ca5d666ec90a7df9698c926f585611eac31ce13192f'
      }
    },
    {
      step_index: 2,
      step_name: 'CertificatePending',
      status: 'done',
      start_date: '2026-08-07T14:44:45.776405692Z',
      end_date: '2026-08-07T14:45:06.844644141Z',
      result: {
        certificate_id: '0xfd92b4854c0364e0a9e8e3bade6bbcc0873a6be917321320d7e2f24e24f7131f',
        status: 4,
        status_string: 'Settled',
        settlement_tx_hash: '0x1bf33df3df7e20de949cb8e8dd664c1a928a009d8af2692894a7df9fdc6a76e7'
      }
    },
    {
      step_index: 3,
      step_name: 'WaitL1SettledGER',
      status: 'done',
      start_date: '2026-08-07T14:45:06.844644141Z',
      end_date: '2026-08-07T14:45:06.844644141Z',
      result: {
        tx_hash: '0x1bf33df3df7e20de949cb8e8dd664c1a928a009d8af2692894a7df9fdc6a76e7',
        block_number: 511,
        ger: '0xe95cc8832a43e15f02052ae8d436589fc0ad89643e4a7a0f1af7242016f173b7',
        l1_info_tree_index: 5,
        has_verify_batches_trusted_aggregator: true,
        has_update_l1_info_tree: true,
        has_update_l1_info_tree_v2: true
      }
    },
    {
      step_index: 4,
      step_name: 'WaitingClaim',
      status: 'done',
      start_date: '2026-08-07T14:45:06.844644141Z',
      end_date: '2026-08-07T14:47:26.844119964Z',
      result: {
        claim_tx: '0x51d247094346142f780378bfb82a1e54b152db5d4035ec4e6937c531c47b0145',
        block_number: 583
      }
    },
    {
      step_index: 5,
      step_name: 'Claimed',
      status: 'done',
      start_date: '2026-08-07T14:47:26.844119964Z',
      end_date: '2026-08-07T14:47:26.844119964Z'
    }
  ],
  error: null
};

// L2->L2 mid-flight: 7 steps, step_index 4 (WaitingGERInjection) inProgress.
export const l2l2RunningFixture: AggkitTrackingData = {
  tracking_status: 'running',
  network_id: 1,
  tx_hash: '0x66a20ab10e92748f7ee30f9a487e262a673b790df365bf3067a59c8b71fb2fe8',
  bridge_status: {
    bridge_type: 'L2->L2',
    block_number: 1143,
    log_index: 0,
    block_timestamp: 1786114192,
    event: {
      leaf_type: 'Asset',
      origin_network: 0,
      origin_address: '0x0000000000000000000000000000000000000000',
      destination_network: 2,
      destination_address: '0x4e0ff24158eeac22ed9abfe3abbbda6d6a609fe0',
      amount: '20000000000000000',
      deposit_count: 2
    }
  },
  step_index: 4,
  all_steps: [
    {
      step_index: 0,
      step_name: 'WaitingLERUpdate',
      status: 'done',
      start_date: '2026-08-07T14:49:59.046296597Z',
      end_date: '2026-08-07T14:49:59.048885846Z',
      result: {
        network_id: 1,
        ler: '0x70790a490a3fd74bd69a3321fe08acda9ec621054d0a88b559992db0a625bbfb',
        block_number: 1143
      }
    },
    {
      step_index: 1,
      step_name: 'PendingInclusion',
      status: 'done',
      start_date: '2026-08-07T14:49:59.048885846Z',
      end_date: '2026-08-07T14:49:59.048885846Z',
      result: {
        certificate_id: '0xe56cb2819d2eeaa33113b54ede35f061e334eb74f47b783443326127336e29c2',
        new_ler: '0x70790a490a3fd74bd69a3321fe08acda9ec621054d0a88b559992db0a625bbfb',
        previous_ler: '0x3ba1af1eba0fbefdbd0b741efc3d805119a3b192663784bf8974f7dc27d3f41e'
      }
    },
    {
      step_index: 2,
      step_name: 'CertificatePending',
      status: 'done',
      start_date: '2026-08-07T14:49:59.048885846Z',
      end_date: '2026-08-07T14:50:06.843777138Z',
      result: {
        certificate_id: '0xe56cb2819d2eeaa33113b54ede35f061e334eb74f47b783443326127336e29c2',
        status: 4,
        status_string: 'Settled',
        settlement_tx_hash: '0x9016f9365aca01c8da56e2b97d2b1f53e7758b5dd0ed02d303bab46f242ee5a0'
      }
    },
    {
      step_index: 3,
      step_name: 'WaitL1SettledGER',
      status: 'done',
      start_date: '2026-08-07T14:50:06.843777138Z',
      end_date: '2026-08-07T14:50:06.843777138Z',
      result: {
        tx_hash: '0x9016f9365aca01c8da56e2b97d2b1f53e7758b5dd0ed02d303bab46f242ee5a0',
        block_number: 663,
        ger: '0x6989b12606017b91d6defe2184415b5071fb7004e8daee4b3b82efd5e54045ff',
        l1_info_tree_index: 7,
        has_verify_batches_trusted_aggregator: true,
        has_update_l1_info_tree: true,
        has_update_l1_info_tree_v2: true
      }
    },
    {
      step_index: 4,
      step_name: 'WaitingGERInjection',
      status: 'inProgress',
      start_date: '2026-08-07T14:50:06.843777138Z'
    },
    {
      step_index: 5,
      step_name: 'WaitingClaim',
      status: 'pending'
    },
    {
      step_index: 6,
      step_name: 'Claimed',
      status: 'pending'
    }
  ],
  error: null
};

// SYNTHESIZED (not a captured fixture -- per S9 context pack, no captured
// fixture has a step-level error, so this is l2l2RunningFixture with step 4
// (WaitingGERInjection) turned into a step-level `error`. Per aggkit
// v0.11.0-rc4 (bridgetracker/domain/tracking_data.go: TrackingStatus derives
// from the step at step_index, so a step in `error` makes tracking_status
// 'error'; API.md's WebSocket section spells out the same), the top-level
// tracking_status here is 'error' -- NOT 'running' -- while bridge_status
// stays populated. That populated bridge_status is exactly what
// distinguishes this retryable state from the tracker's giving-up terminal
// (tracking_status 'error' with bridge_status null, errorGiveupFixture
// below): per useBridgeTracking.ts's isTrackingTerminal, polling must
// continue here.
export const l2l2RunningStepErrorFixture: AggkitTrackingData = {
  ...l2l2RunningFixture,
  tracking_status: 'error',
  all_steps: l2l2RunningFixture.all_steps!.map((step) =>
    step.step_index === 4
      ? {
          ...step,
          status: 'error' as const,
          error: {
            error_type: 0 as const,
            error_type_string: 'transient' as const,
            retry_count: 2,
            description: ['ger injection not yet observed on destination network']
          }
        }
      : step
  )
};

// The giving-up terminal: tracker could not resolve the bridge at all
// (tx not found / not a bridge tx). bridge_status and all_steps stay null.
export const errorGiveupFixture: AggkitTrackingData = {
  tracking_status: 'error',
  network_id: 1,
  tx_hash: '0xdeadbeef00000000000000000000000000000000000000000000000000000000',
  bridge_status: null,
  step_index: null,
  all_steps: null,
  error: {
    error_type: 2,
    error_type_string: 'exhausted',
    retry_count: 5,
    description: [
      'network=1/tx=0xdeadbeef00000000000000000000000000000000000000000000000000000000 does not exist on the network'
    ]
  }
};
