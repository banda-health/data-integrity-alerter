# data-integrity-alerter
This sets up a cron job that runs every 5 minutes to query a DB and check for any data integrity/inconsistency problems. It keeps track of previous data that was analyzed so that we don't continually get notifications on the same data. This data is stored in `current-data.json` (if any or if the script has been run the first time).

This was designed on Node 22 and the associated `npm` version.

## Setup
To install this on a new server, do the same you'd do for development. So, install the code, then run
```
npm install
```

## Configuration
Copy the `.env.example` file and rename it to `.env` and set the properties.

## Set up a system process to run this
Do the following:
1. In `/lib/systemd/system/data-integrity-alerter.service`, create the `data-integrity-alerter.service` and populate it with the same contents as that file in this repository.
2. Reload the daemon by `sudo systemctl daemon-reload`.
3. Ensure SystemD will automatically start the service by running `sudo systemctl enable data-integrity-alerter`.
3. Start the service `sudo systemctl start data-integrity-alerter`.
4. (Optional) Check the service status `sudo systemctl status data-integrity-alerter`.
