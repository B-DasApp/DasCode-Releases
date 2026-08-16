# DasCode Releases

Official desktop releases and update metadata for DasCode. This public repository is also the
protected release controller for the private `B-DasApp/DasCode` source repository.

Download current installers from the [Releases](../../releases) page. This repository intentionally
contains no application source code and never builds or checks out the private source. The controller
accepts only a reviewed source ref plus its full commit SHA, transfers a checksum-bound publication
bundle from the credential-free private worker, and gates each external publication here.

Maintainer setup, trust boundaries, and first-release instructions are in
[`docs/release-controller.md`](docs/release-controller.md). The cross-repository wire format is in
[`docs/artifact-contract.md`](docs/artifact-contract.md).
