### Teams

Team definition (shared by GitHub and Jira):

 - `administration` - can manage anything
 - `project management` - can have access to stats and documentation. Approves releases and `IQ`s
 - `ci/cd` - can manage ci/cd, approve `PR`s on CI, docker and issue template files and manage jira ticket templates, flows and automations
 - `marketing` - can view documentation. can edit marketing docs
 - `quality` - can view/edit documentation. Must approve all `PR`s and `IQ`s
 - `tech-leads` - MUST approve `PR`s on code and docs (are also part of `development`)
 - `development` - Active developers of the project. Can write to code, ci and doc files
 - `contributors` - Regular contributors to the project. Can write to code and doc files. `PR`s require pre-approval on first X `PR`s before test CI
 - `external` - can write to code and doc files. `PR`s require pre-approval before test CI