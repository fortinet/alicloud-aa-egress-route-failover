import axios from 'axios';
import https from 'https';

const { FULL_URL, API_KEY } = process.env;

exports.callHealthCheck = async function(event, context, callback): Promise<void> {
    console.log('Timer Function Called');
    var url = FULL_URL;
    const agent = new https.Agent({
        rejectUnauthorized: false
    });
    var options = {
        httpsAgent: agent,
        headers: {
            Authorization: 'Bearer ' + API_KEY
        }
    };
    try {
        console.log(`Calling ${FULL_URL}`);
        await axios.get(url, options);
    } catch (err) {
        console.error(`Error in CallHealthCheck Function. Error : ${err} `);
        callback(err);
    }
    // Terminate function.
    callback(null, 'CallHealthCheck Terminated.');
};
if (module === require.main) {
    exports.callHealthCheck(console.log);
}
